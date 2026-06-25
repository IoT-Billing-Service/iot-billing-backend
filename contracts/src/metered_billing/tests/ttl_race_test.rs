#[cfg(test)]
mod tests {
    use soroban_sdk::{Env, Address, BytesN};
    use crate::metered_billing::ttl_state::{extend_ttl, initialize_ttl, is_ttl_valid, get_ttl_deadline, TtlError};
    use crate::metered_billing::storage::{initialize_storage, allocate_storage, get_storage_usage, get_metered_entries, ENTRY_SIZE};
    use crate::metered_billing::telemetry::{process_telemetry_batch, TelemetryEvent, TelemetryBatch, TelemetryError};

    #[test]
    fn test_atomic_ttl_extension_prevents_race_condition() {
        let env = Env::with_mock_host();
        
        // Create a device ID
        let device_id = Address::generate(&env);
        
        // Initialize TTL and storage for the device
        initialize_ttl(&env, &device_id);
        initialize_storage(&env, &device_id);
        
        // Simulate 1000 concurrent TTL extension attempts
        // In a real scenario, these would be concurrent invocations
        let mut successful_extensions = 0;
        let mut conflict_errors = 0;
        
        for i in 0..1000 {
            // Each attempt tries to extend TTL
            match extend_ttl(&env, &device_id) {
                Ok(()) => successful_extensions += 1,
                Err(TtlError::TtlExtensionConflict) => conflict_errors += 1,
                Err(_) => panic!("Unexpected error in TTL extension"),
            }
        }
        
        // Verify that only one extension succeeded (the first one)
        // and all others received conflict errors
        assert_eq!(successful_extensions, 1, "Only one TTL extension should succeed");
        assert_eq!(conflict_errors, 999, "All other attempts should get conflict errors");
        
        // Verify the TTL deadline is set correctly
        let deadline = get_ttl_deadline(&env, &device_id);
        assert!(deadline.is_some(), "TTL deadline should be set");
        
        // Verify storage usage invariant: storage_usage_bytes == allocated_entries * ENTRY_SIZE
        let storage_usage = get_storage_usage(&env, &device_id);
        let metered_entries = get_metered_entries(&env, &device_id);
        
        // Initially, no storage is allocated
        assert_eq!(storage_usage, 0, "Initial storage usage should be 0");
        assert_eq!(metered_entries, 0, "Initial metered entries should be 0");
        assert_eq!(storage_usage, metered_entries * ENTRY_SIZE, "Storage invariant violated");
    }

    #[test]
    fn test_concurrent_telemetry_batch_processing() {
        let env = Env::with_mock_host();
        
        // Create device IDs
        let device_1 = Address::generate(&env);
        let device_2 = Address::generate(&env);
        
        // Initialize TTL and storage for both devices
        initialize_ttl(&env, &device_1);
        initialize_storage(&env, &device_1);
        initialize_ttl(&env, &device_2);
        initialize_storage(&env, &device_2);
        
        // Simulate concurrent telemetry batch submissions from multiple devices
        // Each device submits 100 batches with 10 events each
        let events_per_batch = 10;
        let batches_per_device = 100;
        let bytes_per_event = 512;
        
        for device in [device_1.clone(), device_2.clone()] {
            for batch_num in 0..batches_per_device {
                let batch_id = BytesN::from_array(&env, &[batch_num as u8; 32]);
                
                // Create telemetry events
                let mut events = Vec::new(&env);
                for event_num in 0..events_per_batch {
                    let event = TelemetryEvent {
                        timestamp: env.ledger().timestamp(),
                        device_id: device.clone(),
                        event_type: 1,
                        payload_hash: BytesN::from_array(&env, &[event_num as u8; 32]),
                    };
                    events.push_back(event);
                }
                
                let batch = TelemetryBatch {
                    events,
                    batch_id,
                };
                
                // Process the batch
                match process_telemetry_batch(&env, &device, &batch) {
                    Ok(()) => {},
                    Err(e) => panic!("Batch processing failed: {:?}", e),
                }
            }
        }
        
        // Verify storage usage invariant for both devices
        for device in [device_1, device_2] {
            let storage_usage = get_storage_usage(&env, &device);
            let metered_entries = get_metered_entries(&env, &device);
            
            let expected_usage = (events_per_batch * batches_per_device * bytes_per_event) as u64;
            let expected_entries = expected_usage / ENTRY_SIZE;
            
            assert_eq!(storage_usage, expected_usage, "Storage usage should match expected");
            assert_eq!(metered_entries, expected_entries, "Metered entries should match expected");
            assert_eq!(storage_usage, metered_entries * ENTRY_SIZE, "Storage invariant violated");
        }
    }

    #[test]
    fn test_storage_capacity_enforcement() {
        let env = Env::with_mock_host();
        
        let device_id = Address::generate(&env);
        
        initialize_ttl(&env, &device_id);
        initialize_storage(&env, &device_id);
        
        // Try to allocate more than MAX_STORAGE_PER_DEVICE
        let batch_id = BytesN::from_array(&env, &[0u8; 32]);
        let mut events = Vec::new(&env);
        
        // Create a batch that would exceed capacity
        for _ in 0..2000 { // 2000 events * 512 bytes = 1,024,000 bytes > 512KB
            let event = TelemetryEvent {
                timestamp: env.ledger().timestamp(),
                device_id: device_id.clone(),
                event_type: 1,
                payload_hash: BytesN::from_array(&env, &[0u8; 32]),
            };
            events.push_back(event);
        }
        
        let batch = TelemetryBatch {
            events,
            batch_id,
        };
        
        // This should fail due to capacity exceeded
        match process_telemetry_batch(&env, &device_id, &batch) {
            Err(TelemetryError::StorageCapacityExceeded) => {},
            _ => panic!("Should have failed with StorageCapacityExceeded"),
        }
    }

    #[test]
    fn test_ttl_expiry_handling() {
        let env = Env::with_mock_host();
        
        let device_id = Address::generate(&env);
        
        // Don't initialize TTL - it should be invalid
        initialize_storage(&env, &device_id);
        
        let batch_id = BytesN::from_array(&env, &[0u8; 32]);
        let events = Vec::new(&env);
        
        let batch = TelemetryBatch {
            events,
            batch_id,
        };
        
        // This should fail due to expired TTL
        match process_telemetry_batch(&env, &device_id, &batch) {
            Err(TelemetryError::TtlExpired) => {},
            _ => panic!("Should have failed with TtlExpired"),
        }
    }
}
