#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use soroban_sdk::{Env, Address, BytesN};
    use crate::metered_billing::ttl_state::{extend_ttl, initialize_ttl, get_ttl_deadline, TtlError};
    use crate::metered_billing::storage::{initialize_storage, allocate_storage, get_storage_usage, get_metered_entries, MAX_STORAGE_PER_DEVICE, ENTRY_SIZE};
    use crate::metered_billing::telemetry::{process_telemetry_batch, TelemetryEvent, TelemetryBatch, TelemetryError};

    proptest! {
        #[test]
        fn prop_concurrent_ttl_extensions(
            num_attempts in 1..1000usize,
        ) {
            let env = Env::with_mock_host();
            let device_id = Address::generate(&env);
            
            initialize_ttl(&env, &device_id);
            initialize_storage(&env, &device_id);
            
            let mut successful_extensions = 0;
            let mut conflict_errors = 0;
            
            for _ in 0..num_attempts {
                match extend_ttl(&env, &device_id) {
                    Ok(()) => successful_extensions += 1,
                    Err(TtlError::TtlExtensionConflict) => conflict_errors += 1,
                    Err(_) => panic!("Unexpected error in TTL extension"),
                }
            }
            
            // Only one extension should succeed regardless of number of attempts
            prop_assert_eq!(successful_extensions, 1);
            prop_assert_eq!(conflict_errors, num_attempts - 1);
            
            // Verify storage invariant
            let storage_usage = get_storage_usage(&env, &device_id);
            let metered_entries = get_metered_entries(&env, &device_id);
            prop_assert_eq!(storage_usage, metered_entries * ENTRY_SIZE);
        }

        #[test]
        fn prop_random_telemetry_batches(
            num_batches in 1..100usize,
            events_per_batch in 1..100usize,
            device_seed in 0u64..1000u64,
        ) {
            let env = Env::with_mock_host();
            let device_id = Address::generate(&env);
            
            initialize_ttl(&env, &device_id);
            initialize_storage(&env, &device_id);
            
            let bytes_per_event = 512u64;
            let mut total_events = 0u64;
            
            for batch_num in 0..num_batches {
                let batch_id = BytesN::from_array(&env, &[(batch_num % 256) as u8; 32]);
                
                let mut events = Vec::new(&env);
                for event_num in 0..events_per_batch {
                    let event = TelemetryEvent {
                        timestamp: env.ledger().timestamp(),
                        device_id: device_id.clone(),
                        event_type: ((event_num + device_seed as usize) % 1000) as u32,
                        payload_hash: BytesN::from_array(&env, &[((event_num + batch_num) % 256) as u8; 32]),
                    };
                    events.push_back(event);
                }
                
                let batch = TelemetryBatch {
                    events,
                    batch_id,
                };
                
                // Check if this batch would exceed capacity
                let batch_size = events_per_batch as u64 * bytes_per_event;
                let current_usage = get_storage_usage(&env, &device_id);
                
                if current_usage + batch_size > MAX_STORAGE_PER_DEVICE {
                    // Should fail with capacity exceeded
                    match process_telemetry_batch(&env, &device_id, &batch) {
                        Err(TelemetryError::StorageCapacityExceeded) => {},
                        _ => prop_assert!(false, "Should fail with StorageCapacityExceeded"),
                    }
                } else {
                    // Should succeed
                    match process_telemetry_batch(&env, &device_id, &batch) {
                        Ok(()) => {
                            total_events += events_per_batch as u64;
                        },
                        Err(e) => prop_assert!(false, "Batch should succeed but failed: {:?}", e),
                    }
                }
            }
            
            // Verify storage invariant
            let storage_usage = get_storage_usage(&env, &device_id);
            let metered_entries = get_metered_entries(&env, &device_id);
            prop_assert_eq!(storage_usage, metered_entries * ENTRY_SIZE);
        }

        #[test]
        fn prop_multiple_devices_concurrent_submissions(
            num_devices in 2..10usize,
            batches_per_device in 1..50usize,
            events_per_batch in 1..50usize,
        ) {
            let env = Env::with_mock_host();
            let mut devices = Vec::new();
            
            // Create devices
            for _ in 0..num_devices {
                let device_id = Address::generate(&env);
                initialize_ttl(&env, &device_id);
                initialize_storage(&env, &device_id);
                devices.push(device_id);
            }
            
            let bytes_per_event = 512u64;
            
            // Process batches for each device
            for (device_idx, device_id) in devices.iter().enumerate() {
                for batch_num in 0..batches_per_device {
                    let batch_id = BytesN::from_array(&env, &[((batch_num + device_idx) % 256) as u8; 32]);
                    
                    let mut events = Vec::new(&env);
                    for event_num in 0..events_per_batch {
                        let event = TelemetryEvent {
                            timestamp: env.ledger().timestamp(),
                            device_id: device_id.clone(),
                            event_type: ((event_num + device_idx) % 1000) as u32,
                            payload_hash: BytesN::from_array(&env, &[((event_num + batch_num) % 256) as u8; 32]),
                        };
                        events.push_back(event);
                    }
                    
                    let batch = TelemetryBatch {
                        events,
                        batch_id,
                    };
                    
                    // Check capacity
                    let batch_size = events_per_batch as u64 * bytes_per_event;
                    let current_usage = get_storage_usage(&env, device_id);
                    
                    if current_usage + batch_size > MAX_STORAGE_PER_DEVICE {
                        // Should fail
                        match process_telemetry_batch(&env, device_id, &batch) {
                            Err(TelemetryError::StorageCapacityExceeded) => {},
                            _ => prop_assert!(false, "Should fail with StorageCapacityExceeded"),
                        }
                    } else {
                        // Should succeed
                        match process_telemetry_batch(&env, device_id, &batch) {
                            Ok(()) => {},
                            Err(e) => prop_assert!(false, "Batch should succeed but failed: {:?}", e),
                        }
                    }
                }
                
                // Verify storage invariant for this device
                let storage_usage = get_storage_usage(&env, device_id);
                let metered_entries = get_metered_entries(&env, device_id);
                prop_assert_eq!(storage_usage, metered_entries * ENTRY_SIZE);
            }
        }

        #[test]
        fn prop_storage_never_exceeds_capacity(
            num_allocations in 1..1000usize,
            allocation_size in 512u64..524288u64,
        ) {
            let env = Env::with_mock_host();
            let device_id = Address::generate(&env);
            
            initialize_ttl(&env, &device_id);
            initialize_storage(&env, &device_id);
            
            let mut total_allocated = 0u64;
            
            for _ in 0..num_allocations {
                let current_usage = get_storage_usage(&env, &device_id);
                
                if current_usage + allocation_size <= MAX_STORAGE_PER_DEVICE {
                    allocate_storage(&env, &device_id, allocation_size);
                    total_allocated += allocation_size;
                }
                
                // Verify invariant after each allocation
                let storage_usage = get_storage_usage(&env, &device_id);
                prop_assert!(storage_usage <= MAX_STORAGE_PER_DEVICE, "Storage exceeded capacity");
                
                let metered_entries = get_metered_entries(&env, &device_id);
                prop_assert_eq!(storage_usage, metered_entries * ENTRY_SIZE);
            }
        }
    }
}
