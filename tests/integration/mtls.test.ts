import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MtlsGatewayVerifier } from '../../src/api/gateway/mtls_verifier.js';
import { PrismaClient } from '@prisma/client';
import { closeRedis } from '../../src/database/redis.js';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

describe('mTLS Gateway Verifier Integration', () => {
  let verifier: MtlsGatewayVerifier | null = null;
  let prisma: PrismaClient | null = null;
  let ocspApp: FastifyInstance | null = null;
  let dbAvailable = false;
  let ocspUrl = '';
  let ocspStatus = 'GOOD';

  beforeAll(async () => {
    if (process.env['DATABASE_URL'] == null) return;
    prisma = new PrismaClient();

    try {
      await prisma.$connect();
      dbAvailable = true;
    } catch {
      dbAvailable = false;
      await prisma.$disconnect();
      prisma = null;
      return;
    }

    // Start mock OCSP server
    ocspApp = Fastify();
    ocspApp.addContentTypeParser(
      'application/ocsp-request',
      { parseAs: 'buffer' },
      (_req, body, done) => {
        done(null, body);
      },
    );
    ocspApp.post('/ocsp', async () => {
      await Promise.resolve();
      return ocspStatus;
    });
    await ocspApp.listen({ port: 0, host: '127.0.0.1' });
    const address = ocspApp.server.address() as AddressInfo;
    ocspUrl = `http://127.0.0.1:${String(address.port)}/ocsp`;

    // Ensure test certificates exist in DB
    await prisma.hardwareCertificate.upsert({
      where: { serial: '12345678' },
      update: { revoked: false },
      create: { serial: '12345678', model: 'TEST-A', batch: 'B1' },
    });

    await prisma.hardwareCertificate.upsert({
      where: { serial: '87654321' },
      update: { revoked: true },
      create: { serial: '87654321', model: 'TEST-B', batch: 'B1', revoked: true },
    });

    verifier = new MtlsGatewayVerifier();
    await verifier.init();
  });

  afterAll(async () => {
    try {
      if (verifier) await verifier.close();
    } catch (e) {
      console.error('verifier close error', e);
    }
    try {
      if (prisma !== null) {
        await prisma.hardwareCertificate.deleteMany({
          where: { serial: { in: ['12345678', '87654321'] } },
        });
      }
    } catch (e) {
      console.error('prisma delete error', e);
    }
    try {
      if (prisma !== null) await prisma.$disconnect();
    } catch (e) {
      console.error('prisma disconnect error', e);
    }
    try {
      if (ocspApp) await ocspApp.close();
    } catch (e) {
      console.error('ocspApp close error', e);
    }
    try {
      await closeRedis();
    } catch (e) {
      console.error('closeRedis error', e);
    }
  });

  function generateCert(serialHex: string): string {
    const tmpDir = os.tmpdir();
    const crtFile = path.join(tmpDir, `cert-${serialHex}.crt`);
    const keyFile = path.join(tmpDir, `key-${serialHex}.key`);
    const csrFile = path.join(tmpDir, `req-${serialHex}.csr`);
    const extFile = path.join(tmpDir, `ext-${serialHex}.cnf`);

    // Write the extension file needed for the OCSP URL
    fs.writeFileSync(extFile, `authorityInfoAccess=OCSP;URI:${ocspUrl}\n`);

    // 1. Generate private key and CSR
    execFileSync('openssl', [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyFile,
      '-out',
      csrFile,
      '-nodes',
      '-subj',
      '/CN=TestDevice',
    ]);

    // 2. Self-sign the CSR to create the certificate with the specific serial and extension
    execFileSync('openssl', [
      'x509',
      '-req',
      '-in',
      csrFile,
      '-signkey',
      keyFile,
      '-out',
      crtFile,
      '-days',
      '365',
      '-set_serial',
      `0x${serialHex}`,
      '-extfile',
      extFile,
    ]);

    const cert = fs.readFileSync(crtFile, 'utf-8');

    // Clean up temp files
    try {
      fs.unlinkSync(keyFile);
    } catch (e) {
      void e;
    }
    try {
      fs.unlinkSync(csrFile);
    } catch (e) {
      void e;
    }
    try {
      fs.unlinkSync(crtFile);
    } catch (e) {
      void e;
    }
    try {
      fs.unlinkSync(extFile);
    } catch (e) {
      void e;
    }

    return cert;
  }

  it('should verify a valid certificate against the database and OCSP', async () => {
    if (!dbAvailable || verifier === null) return;
    ocspStatus = 'GOOD';
    const certStr = generateCert('12345678');
    const result = await verifier.verifyConnection(certStr);

    expect(result.verified).toBe(true);
    expect(result.serialNumber).toBe('12345678'); // Node trims leading zeroes, so 12345678 hex matches
  });

  it('should reject a certificate that is revoked in the database', async () => {
    if (!dbAvailable || verifier === null) return;
    ocspStatus = 'GOOD';
    const certStr = generateCert('87654321');
    const result = await verifier.verifyConnection(certStr);

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('revoked');
  });

  it('should reject a certificate if OCSP returns REVOKED', async () => {
    if (!dbAvailable || verifier === null) return;
    ocspStatus = 'REVOKED';
    const certStr = generateCert('12345678');
    const result = await verifier.verifyConnection(certStr);

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('OCSP');
  });
});
