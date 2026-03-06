import { CompileResult } from '../compiler.types';

/**
 * Compiler Service Interface
 *
 * Faz 1: Mock implementation (always returns success)
 * Faz 2: Codesys Automation Server integration
 */
export interface ICompilerService {
  compile(
    code: string,
    target: string,
    tenantId: string,
  ): Promise<CompileResult>;

  getStatus(): Promise<CompilerStatus>;
}

export interface CompilerStatus {
  available: boolean;
  backend: 'mock' | 'codesys';
  version?: string;
  lastCompileAt?: Date;
}

export const COMPILER_SERVICE = 'COMPILER_SERVICE';
