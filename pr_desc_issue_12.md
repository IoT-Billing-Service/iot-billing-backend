Closes #12

## Description

This PR implements the Mutual TLS (mTLS) Ingestion Gateway with Custom X.509 Hardware Checks as required in Issue #12. 

Key architectural changes and features:
- **Database Schema**: Replaced the in-memory whitelist with a PostgreSQL-backed `HardwareCertificate` table.
- **Caching**: Implemented an $O(1)$ lookup using Redis to cache active and revoked certificate statuses.
- **Hot-Reload**: Introduced Postgres `LISTEN/NOTIFY` via a dedicated client in the `MtlsGatewayVerifier` to instantly invalidate Redis cache on certificate revocation.
- **Admin Revocation**: Created the `PATCH /api/admin/certificates/:serial/revoke` endpoint to handle real-time revocations.
- **OCSP Stapling/Verification**: Added OCSP verification capability against the URI extracted from the X.509 certificate's Subject Information Access extension to enforce real-time checks under 200ms.
- **Testing**: Added integration tests using dynamically generated self-signed certificates and a mock Fastify OCSP responder server.
