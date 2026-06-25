use soroban_sdk::{Env, Address, BytesN, contracttype, contracterror, Vec, Map};
use crate::metered_billing::ttl_state::{extend_ttl, is_ttl_valid, TtlError};
use crate::metered_billing::storage::{allocate_storage, get_storage_usage, MAX_STORAGE_PER_DEVICE};

// Error codes
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum TelemetryError {
    InvalidDeviceId = 100,
    TtlExpired = 101,
    StorageCapacityExceeded = 102,
    TelemetryBurstExceeded = 103,
    TtlExtensionFailed = 104,
}

#[contracttype]
pub struct TelemetryEvent {
    pub timestamp: u64,
    pub device_id: Address,
    pub event_type: u32,
    pub payload_hash: BytesN<32>,
}

#[contracttype]
pub struct TelemetryBatch {
    pub events: Vec<TelemetryEvent>,
    pub batch_id: BytesN<32>,
}

/// Processes a batch of telemetry events for a device
/// 
/// This function handles batch telemetry ingestion with proper TTL checks
/// and storage allocation. It calls extend_ttl() per-device to ensure
/// the device's storage remains alive for the billing cycle.
/// 
/// # Arguments
/// * `env` - The Soroban environment
/// * `device_id` - The device submitting telemetry
/// * `batch` - The batch of telemetry events to process
/// 
/// # Returns
/// * `Ok(())` if the batch was processed successfully
/// * `Err(TelemetryError)` if processing failed
pub fn process_telemetry_batch(
    env: &Env,
    device_id: &Address,
    batch: &TelemetryBatch,
) -> Result<(), TelemetryError> {
    // Check if device TTL is valid
    if !is_ttl_valid(env, device_id) {
        return Err(TelemetryError::TtlExpired);
    }
    
    // Check burst limit
    if batch.events.len() > 1000 {
        return Err(TelemetryError::TelemetryBurstExceeded);
    }
    
    // Calculate required storage for this batch
    let batch_size = batch.events.len() as u64 * 512; // Each event is 512 bytes
    
    // Check current storage usage
    let current_usage = get_storage_usage(env, device_id);
    if current_usage + batch_size > MAX_STORAGE_PER_DEVICE {
        return Err(TelemetryError::StorageCapacityExceeded);
    }
    
    // Attempt to extend TTL atomically
    // This uses the two-phase lock mechanism to prevent race conditions
    match extend_ttl(env, device_id) {
        Ok(()) => {
            // TTL extension successful, allocate storage
            allocate_storage(env, device_id, batch_size);
        }
        Err(TtlError::TtlExtensionConflict) => {
            // Another invocation already extended TTL, but that's okay
            // We still need to allocate storage for this batch
            allocate_storage(env, device_id, batch_size);
        }
        Err(e) => {
            // Other TTL errors are fatal
            return Err(TelemetryError::TtlExtensionFailed);
        }
    }
    
    // Store the telemetry events
    store_telemetry_events(env, device_id, batch);
    
    Ok(())
}

/// Stores telemetry events in persistent storage
fn store_telemetry_events(env: &Env, device_id: &Address, batch: &TelemetryBatch) {
    let storage_key = TelemetryStorageKey {
        device_id: device_id.clone(),
        batch_id: batch.batch_id.clone(),
    };
    
    env.storage().instance().set(&storage_key, batch);
}

#[contracttype]
pub struct TelemetryStorageKey {
    pub device_id: Address,
    pub batch_id: BytesN<32>,
}

/// Validates a telemetry event
pub fn validate_event(event: &TelemetryEvent) -> bool {
    // Basic validation checks
    event.event_type < 1000 && // Event type must be in valid range
    event.timestamp > 0 // Timestamp must be positive
}

/// Gets the count of telemetry events for a device
pub fn get_telemetry_count(env: &Env, device_id: &Address) -> u64 {
    let count_key = TelemetryCountKey {
        device_id: device_id.clone(),
    };
    
    env.storage().instance()
        .get::<_, u64>(&count_key)
        .unwrap_or(0)
}

#[contracttype]
pub struct TelemetryCountKey {
    pub device_id: Address,
}
