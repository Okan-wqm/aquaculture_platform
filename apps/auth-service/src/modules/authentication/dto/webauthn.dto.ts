import { InputType, Field, ObjectType } from '@nestjs/graphql';
import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import GraphQLJSON from 'graphql-type-json';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

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
  @Field(() => GraphQLJSON, { description: 'Full RegistrationResponseJSON from @simplewebauthn/browser startRegistration()' })
  response!: RegistrationResponseJSON;

  @Field({ nullable: true, description: 'Device name for this credential' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceName?: string;

  @Field(() => [String], { nullable: true, description: 'Supported transports override; normally read from the verified browser response' })
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
  @Field(() => GraphQLJSON, { description: 'Full AuthenticationResponseJSON from @simplewebauthn/browser startAuthentication()' })
  response!: AuthenticationResponseJSON;
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

  @Field(() => GraphQLJSON, { description: 'Full PublicKeyCredentialCreationOptionsJSON for @simplewebauthn/browser startRegistration()' })
  options!: PublicKeyCredentialCreationOptionsJSON;
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

  @Field(() => GraphQLJSON, { description: 'Full PublicKeyCredentialRequestOptionsJSON for @simplewebauthn/browser startAuthentication()' })
  options!: PublicKeyCredentialRequestOptionsJSON;
}

@ObjectType()
export class WebAuthnRemoveResponse {
  @Field()
  success!: boolean;

  @Field({ nullable: true })
  message?: string;
}
