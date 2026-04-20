//! Should NOT compile: NatsClient does not expose a token auth
//! constructor. Adding one would silently violate ADR-014/015.

use nats_client::NatsClient;

fn main() {
    let _ = NatsClient::with_token("opaque-token");
}
