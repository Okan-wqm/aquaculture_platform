import { InputType, Field, ObjectType, Int } from '@nestjs/graphql';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsIn,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Authenticator transports the browser can report (WebAuthn L3). */
export const WEBAUTHN_TRANSPORTS = [
  'usb',
  'nfc',
  'ble',
  'internal',
  'hybrid',
  'smart-card',
] as const;
export type WebAuthnTransport = (typeof WEBAUTHN_TRANSPORTS)[number];

// ============================================================================
// WebAuthn Input DTOs
// ============================================================================

@InputType()
export class WebAuthnRegistrationChallengeInput {
  @Field({ description: 'Optional device name for credential identification' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceName?: string;
}

/**
 * Registration payload mirrors the browser's RegistrationResponseJSON.
 *
 * SEC-CRITICAL-001/002 (2026-08-23 scan): the public key is NO LONGER
 * client-supplied. `verifyRegistrationResponse` derives the COSE key from
 * the attestation object (proof-of-possession); clients that never proved
 * possession cannot plant a key.
 *
 * BREAKING CHANGE: `publicKey` and `origin` inputs were removed;
 * `attestationObject` + `publicKeyAlgorithm` + `currentPassword` are new.
 */
@InputType()
export class WebAuthnRegisterCredentialInput {
  @Field({ description: 'Base64url-encoded credential ID from navigator.credentials.create()' })
  @IsString()
  @IsNotEmpty()
  credentialId!: string;

  @Field({
    description:
      'Base64url-encoded attestation object (contains the signed authenticator data and the COSE public key)',
  })
  @IsString()
  @IsNotEmpty()
  attestationObject!: string;

  @Field({ description: 'Base64url-encoded attestation client data JSON' })
  @IsString()
  @IsNotEmpty()
  clientDataJSON!: string;

  @Field(() => Int, {
    description: 'COSE algorithm identifier the authenticator chose (e.g. -7 ES256, -257 RS256)',
  })
  @IsInt()
  publicKeyAlgorithm!: number;

  @Field({
    nullable: true,
    description: 'Base64url-encoded authenticator data (present on some platforms)',
  })
  @IsOptional()
  @IsString()
  authenticatorData?: string;

  @Field({ description: 'Challenge string that was used during registration' })
  @IsString()
  @IsNotEmpty()
  challenge!: string;

  /**
   * SEC-CRITICAL-002: registration requires proof of account ownership.
   * A stolen access token alone must never be enough to plant a
   * biometric backdoor credential.
   */
  @Field({
    description:
      'Current account password (re-authentication required to add a biometric credential)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword!: string;

  @Field({ nullable: true, description: 'Device name for this credential' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceName?: string;

  @Field(() => [String], {
    nullable: true,
    description: 'Supported transports (usb, nfc, ble, internal, hybrid, smart-card)',
  })
  @IsOptional()
  @IsIn(WEBAUTHN_TRANSPORTS, { each: true })
  transports?: WebAuthnTransport[];
}

@InputType()
export class WebAuthnLoginChallengeInput {
  @Field({ description: 'Email address of the user attempting biometric login' })
  @IsString()
  @IsNotEmpty()
  email!: string;
}

/**
 * BREAKING CHANGE (SEC-CRITICAL-001): `origin` removed — the origin is
 * verified server-side against WEBAUTHN_ALLOWED_ORIGINS from the signed
 * clientDataJSON, never from a client-declared field.
 */
@InputType()
export class WebAuthnVerifyLoginInput {
  @Field({ description: 'Base64url-encoded credential ID' })
  @IsString()
  @IsNotEmpty()
  credentialId!: string;

  @Field({ description: 'Base64url-encoded authenticator data' })
  @IsString()
  @IsNotEmpty()
  authenticatorData!: string;

  @Field({ description: 'Base64url-encoded client data JSON' })
  @IsString()
  @IsNotEmpty()
  clientDataJSON!: string;

  @Field({ description: 'Base64url-encoded signature' })
  @IsString()
  @IsNotEmpty()
  signature!: string;

  /**
   * Nullable on the wire because a non-discoverable credential's assertion
   * carries no user handle; the validator already accepted its absence, so a
   * non-null SDL field here was a contract lie the typed client now catches.
   */
  @Field({
    nullable: true,
    description: 'Base64url-encoded user handle (what the authenticator stored)',
  })
  @IsOptional()
  @IsString()
  userHandle?: string;

  @Field({ description: 'Challenge string from the login challenge' })
  @IsString()
  @IsNotEmpty()
  @MinLength(16)
  challenge!: string;
}

// ============================================================================
// WebAuthn Response DTOs
// ============================================================================

@ObjectType()
export class WebAuthnCredentialInfo {
  @Field()
  credentialId!: string;

  @Field()
  deviceName!: string;

  @Field()
  createdAt!: Date;

  @Field()
  lastUsedAt!: Date;
}

@ObjectType()
export class WebAuthnRegistrationChallengeResponse {
  @Field({ description: 'Random challenge for registration ceremony' })
  challenge!: string;

  @Field({ description: 'Relying party ID (domain)' })
  rpId!: string;

  @Field({ description: 'Relying party name' })
  rpName!: string;

  @Field({ description: 'User ID for the credential' })
  userId!: string;

  @Field({ description: 'User display name' })
  userName!: string;
}

@ObjectType()
export class WebAuthnRegisterResponse {
  @Field()
  success!: boolean;

  @Field({ nullable: true })
  message?: string;

  @Field({ nullable: true })
  credentialId?: string;
}

@ObjectType()
export class WebAuthnLoginChallengeResponse {
  @Field({ description: 'Random challenge for authentication ceremony' })
  challenge!: string;

  @Field({ description: 'Relying party ID (domain)' })
  rpId!: string;

  @Field(() => [String], { description: 'Allowed credential IDs for this user' })
  allowedCredentialIds!: string[];
}

@ObjectType()
export class WebAuthnRemoveResponse {
  @Field()
  success!: boolean;

  @Field({ nullable: true })
  message?: string;
}
