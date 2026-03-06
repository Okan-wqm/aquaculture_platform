import { Injectable, Logger } from '@nestjs/common';

import { CompileResult } from '../compiler.types';

import { ICompilerService, CompilerStatus } from './compiler.interface';

/**
 * Mock Compiler Service (Faz 1)
 *
 * Always returns "compilation successful".
 * Will be replaced by Codesys Automation Server integration in Faz 2.
 */
@Injectable()
export class CompilerService implements ICompilerService {
  private readonly logger = new Logger(CompilerService.name);
  private lastCompileAt?: Date;

  async compile(
    code: string,
    target: string,
    tenantId: string,
  ): Promise<CompileResult> {
    this.logger.debug(
      `Mock compile for tenant ${tenantId}, target=${target}, code size=${code.length} bytes`,
    );

    this.lastCompileAt = new Date();

    return {
      success: true,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      compileTimeMs: 1,
    };
  }

  async getStatus(): Promise<CompilerStatus> {
    return {
      available: true,
      backend: 'mock',
      version: '1.0.0-mock',
      lastCompileAt: this.lastCompileAt,
    };
  }
}
