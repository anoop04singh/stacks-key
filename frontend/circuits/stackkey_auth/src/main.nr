use std::ecdsa_secp256k1;
use std::hash::pedersen_hash;

global DOMAIN_TAG: Field = 0x737461636b6b6579;
global PROTOCOL_VERSION: Field = 1;

fn bytes32_to_field(b: [u8; 32]) -> Field {
    let mut f: Field = 0;
    for i in 0..32 {
        f = f * 256 + (b[i] as Field);
    }
    f
}

fn main(
    pubkey_x: [u8; 32],
    pubkey_y: [u8; 32],
    sig_r: [u8; 32],
    sig_s: [u8; 32],
    message_hash: pub [u8; 32],
    nonce: pub Field,
    expiry: pub Field,
    chain_id: pub Field,
) -> pub [Field; 5] {
    let mut sig: [u8; 64] = [0; 64];
    for i in 0..32 {
        sig[i] = sig_r[i];
        sig[i + 32] = sig_s[i];
    }

    let ok = ecdsa_secp256k1::verify_signature(pubkey_x, pubkey_y, sig, message_hash);
    assert(ok, "Invalid secp256k1 ECDSA signature");

    let x_felt = bytes32_to_field(pubkey_x);
    let y_felt = bytes32_to_field(pubkey_y);
    let salt = pedersen_hash([x_felt, y_felt, DOMAIN_TAG, chain_id, PROTOCOL_VERSION]);
    let msg_felt = bytes32_to_field(message_hash);

    [salt, msg_felt, nonce, expiry, chain_id]
}
