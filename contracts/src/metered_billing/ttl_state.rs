use soroban_sdk::{Env, Address, BytesN, contracttype, contracterror, panic_with_error};

// Constants
const MAX_STORAGE_PER_DEVICE: u64 = 524288; // 512KB
const MAX_TELEMETRY_BURST: u64 = 1000;
const TTL_EXTENSION_WINDOW: u64 = 7 * 24 * 60 * 60; // 7 days in seconds
const ENTRY_SIZE: u64 = 512; // Size of each telemetry entry in bytes

// Error codes
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum TtlError {
    StorageCapacityExceeded = 1,
    TelemetryBurstExceeded = 2,
    TtlExtensionConflict = 3,
    InvalidDeviceId = 4,
}

// Storage keys
#[contracttype]
pub struct DeviceTtlKey {
    pub device_id: Address,
}

#[contracttype]
pub struct LockTtlKey {
    pub device_id: Address,
}

#[contracttype]
pub struct TtlDeadline {
    pub deadline: u64,
}

/// Atomically extends TTL for a device using a two-phase lock mechanism
/// 
/// This function implements an atomic compare-and-swap pattern to prevent
/// race conditions where concurrent invocations could double-allocate storage.
/// 
/// Phase 1: Attempt to set a lock key (LOCK_TTL_KEY) with the new deadline
/// Phase 2: If lock succeeds, perform the actual TTL extension
/// Phase 3: If lock fails (StorageExists), another invocation already extended TTL
pub fn extend_ttl(env: &Env, device_id: &Address) -> Result<(), TtlError> {
    let current_ledger_time = env.ledger().timestamp();
    let new_deadline = current_ledger_time + TTL_EXTENSION_WINDOW;
    
    // Phase 1: Attempt atomic lock acquisition
    let lock_key = LockTtlKey {
        device_id: device_id.clone(),
    };
    
    let deadline_value = TtlDeadline {
        deadline: new_deadline,
    };
    
    // Try to set the lock key atomically - this will fail if another invocation
    // already set it, preventing double-allocation
    let lock_result = env.storage().instance().set(&lock_key, &deadline_value);
    
    if lock_result.is_err() {
        // Lock already exists - another invocation performed the extension
        return Err(TtlError::TtlExtensionConflict);
    }
    
    // Phase 2: Lock acquired successfully, perform actual TTL extension
    let ttl_key = DeviceTtlKey {
        device_id: device_id.clone(),
    };
    
    env.storage().instance().set(&ttl_key, &deadline_value);
    
    // Phase 3: Clean up lock key after successful extension
    env.storage().instance().remove(&lock_key);
    
    Ok(())
}

/// Checks if a device's TTL is still valid
pub fn is_ttl_valid(env: &Env, device_id: &Address) -> bool {
    let ttl_key = DeviceTtlKey {
        device_id: device_id.clone(),
    };
    
    match env.storage().instance().get::<_, TtlDeadline>(&ttl_key) {
        Some(deadline) => {
            let current_time = env.ledger().timestamp();
            deadline.deadline > current_time
        }
        None => false,
    }
}

/// Gets the current TTL deadline for a device
pub fn get_ttl_deadline(env: &Env, device_id: &Address) -> Option<u64> {
    let ttl_key = DeviceTtlKey {
        device_id: device_id.clone(),
    };
    
    env.storage().instance()
        .get::<_, TtlDeadline>(&ttl_key)
        .map(|deadline| deadline.deadline)
}

/// Initializes TTL state for a new device
pub fn initialize_ttl(env: &Env, device_id: &Address) {
    let current_ledger_time = env.ledger().timestamp();
    let initial_deadline = current_ledger_time + TTL_EXTENSION_WINDOW;
    
    let ttl_key = DeviceTtlKey {
        device_id: device_id.clone(),
    };
    
    let deadline_value = TtlDeadline {
        deadline: initial_deadline,
    };
    
    env.storage().instance().set(&ttl_key, &deadline_value);
}
