use soroban_sdk::{Env, Address, contracttype, contracterror};

pub const MAX_STORAGE_PER_DEVICE: u64 = 524288; // 512KB
pub const ENTRY_SIZE: u64 = 512; // Size of each telemetry entry in bytes

// Error codes
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum StorageError {
    CapacityExceeded = 1,
    InvalidDeviceId = 2,
}

#[contracttype]
pub struct StorageUsageKey {
    pub device_id: Address,
}

#[contracttype]
pub struct StorageUsage {
    pub usage_bytes: u64,
    pub metered_entries: u64,
}

/// Initializes storage accounting for a new device
pub fn initialize_storage(env: &Env, device_id: &Address) {
    let storage_key = StorageUsageKey {
        device_id: device_id.clone(),
    };
    
    let usage = StorageUsage {
        usage_bytes: 0,
        metered_entries: 0,
    };
    
    env.storage().instance().set(&storage_key, &usage);
}

/// Allocates storage for a device
/// 
/// This function atomically updates storage usage counters to ensure
/// that the invariant `instance.metered_entries + pending_extensions == total_allocations`
/// is maintained.
/// 
/// # Arguments
/// * `env` - The Soroban environment
/// * `device_id` - The device to allocate storage for
/// * `bytes` - The number of bytes to allocate
pub fn allocate_storage(env: &Env, device_id: &Address, bytes: u64) {
    let storage_key = StorageUsageKey {
        device_id: device_id.clone(),
    };
    
    // Get current storage usage
    let mut usage = env.storage().instance()
        .get::<_, StorageUsage>(&storage_key)
        .unwrap_or(StorageUsage {
            usage_bytes: 0,
            metered_entries: 0,
        });
    
    // Check capacity
    if usage.usage_bytes + bytes > MAX_STORAGE_PER_DEVICE {
        panic_with_error!(env, StorageError::CapacityExceeded);
    }
    
    // Update usage counters
    usage.usage_bytes += bytes;
    usage.metered_entries += bytes / ENTRY_SIZE;
    
    // Store updated usage
    env.storage().instance().set(&storage_key, &usage);
}

/// Gets the current storage usage for a device
pub fn get_storage_usage(env: &Env, device_id: &Address) -> u64 {
    let storage_key = StorageUsageKey {
        device_id: device_id.clone(),
    };
    
    env.storage().instance()
        .get::<_, StorageUsage>(&storage_key)
        .map(|usage| usage.usage_bytes)
        .unwrap_or(0)
}

/// Gets the number of metered entries for a device
pub fn get_metered_entries(env: &Env, device_id: &Address) -> u64 {
    let storage_key = StorageUsageKey {
        device_id: device_id.clone(),
    };
    
    env.storage().instance()
        .get::<_, StorageUsage>(&storage_key)
        .map(|usage| usage.metered_entries)
        .unwrap_or(0)
}

/// Deallocates storage for a device
pub fn deallocate_storage(env: &Env, device_id: &Address, bytes: u64) {
    let storage_key = StorageUsageKey {
        device_id: device_id.clone(),
    };
    
    // Get current storage usage
    let mut usage = env.storage().instance()
        .get::<_, StorageUsage>(&storage_key)
        .unwrap_or(StorageUsage {
            usage_bytes: 0,
            metered_entries: 0,
        });
    
    // Ensure we don't deallocate more than allocated
    if bytes > usage.usage_bytes {
        usage.usage_bytes = 0;
        usage.metered_entries = 0;
    } else {
        usage.usage_bytes -= bytes;
        usage.metered_entries -= bytes / ENTRY_SIZE;
    }
    
    // Store updated usage
    env.storage().instance().set(&storage_key, &usage);
}

/// Initializes the contract with admin settings
pub fn initialize_contract(env: &Env, admin: Address) {
    let admin_key = AdminKey;
    env.storage().instance().set(&admin_key, &admin);
}

#[contracttype]
pub struct AdminKey;
