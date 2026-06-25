pub mod metered_billing;

use soroban_sdk::{contract, contractimpl, contracttype, Env, Address, BytesN};

#[contract]
pub struct MeteredBillingContract;

#[contractimpl]
impl MeteredBillingContract {
    pub fn __constructor(env: &Env, admin: Address) {
        metered_billing::storage::initialize_contract(env, admin);
    }
}
