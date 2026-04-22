//! Should NOT compile: NatsClient does not expose an unauthenticated
//! constructor. mTLS via MtlsConfig is the ONLY path.

use nats_client::NatsClient;

fn main() {
    let _ = NatsClient::connect_unauthenticated("nats://localhost:4222");
}
