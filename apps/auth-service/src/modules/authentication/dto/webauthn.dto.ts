import { InputType, Field, ObjectType } from '@nestjs/graphql';
import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

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

@InputType()
export class WebAuthnRegisterCredentialInput {
  @Field({ description: 'Base64url-encoded credential ID from navigator.credentials.create()' })
  @IsString()
  @IsNotEmpty()
  credentialId!: string;

  @Field({ description: 'Base64url-encoded raw public key (COSE format)' })
  @IsString()
  @IsNotEmpty()
  publicKey!: string;

  @Field({ description: 'Base64url-encoded attestation client data JSON' })
  @IsString()
  @IsNotEmpty()
  clientDataJSON!: string;

  @Field({ description: 'Challenge string that was used during registration' })
  @IsString()
  @IsNotEmpty()
  challenge!: string;

  @Field({ description: 'Origin of the request (e.g., https://example.com)' })
  @IsString()
  @IsNotEmpty()
  origin!: string;

  @Field({ nullable: true, description: 'Device name for this credential' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceName?: string;

  @Field(() => [String], { nullable: true, description: 'Supported transports (usb, nfc, ble, internal)' })
  @IsOptional()
  transports?: string[];
}

@InputType()
export class WebAuthnLoginChallengeInput {
  @Field({ description: 'Email address of the user attempting biometric login' })
  @IsString()
  @IsNotEmpty()
  email!: string;
}

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

  @Field({ description: 'Challenge string from the login challenge' })
  @IsString()
  @IsNotEmpty()
  challenge!: string;

  @Field({ description: 'Origin of the request' })
  @IsString()
  @IsNotEmpty()
  origin!: string;
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
