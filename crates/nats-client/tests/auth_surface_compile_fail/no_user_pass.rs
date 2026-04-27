//! Should NOT compile: NatsClient does not expose a user/pass auth
//! constructor. Adding one would silently violate ADR-014/015.

use nats_client::NatsClient;

fn main() {
    // Nonexistent associated function — must fail to compile.
    let _ = NatsClient::with_user_pass("user", "pass");
}
