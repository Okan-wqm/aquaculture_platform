/**
 * ST Worker Thread Entry Point (piscina)
 *
 * This file runs inside a worker thread. It receives WorkerInput
 * and returns WorkerOutput. Each operation is self-contained:
 * lexer -> parser -> (semantic-analyzer | formatter | outline).
 *
 * The main thread communicates via piscina's task queue.
 * Timeout is enforced by AbortSignal from the main thread.
 */

import type {
  WorkerInput,
  WorkerOutput,
  WorkerAnalyzeResult,
  WorkerFormatResult,
  WorkerOutlineResult,
  WorkerHoverResult,
  WorkerCompleteResult,
  WorkerDefinitionResult,
  WorkerReferencesResult,
  Diagnostic,
  OutlineNode,
} from '../compiler.types';
import { tokenize } from '../lexer';
import { STFormatter } from '../formatter/st-formatter';
import type { ASTNode, VarBlockNode, VarDeclarationNode } from '../parser/st-ast';

/**
 * Main worker function exported for piscina.
 * Receives a WorkerInput and returns a WorkerOutput.
 */
export default async function handler(input: WorkerInput): Promise<WorkerOutput> {
  const startTime = performance.now();

  try {
    // Source size check
    if (input.code.length > input.limits.maxSourceSize) {
      return makeErrorResult(input.taskType, startTime, 'Source code exceeds maximum allowed size');
    }

    switch (input.taskType) {
      case 'analyze':
        return handleAnalyze(input, startTime);
      case 'format':
        return handleFormat(input, startTime);
      case 'outline':
        return handleOutline(input, startTime);
      case 'hover':
        return handleHover(input, startTime);
      case 'complete':
        return handleComplete(input, startTime);
      case 'definition':
        return handleDefinition(input, startTime);
      case 'references':
        return handleReferences(input, startTime);
      default:
        return makeErrorResult(input.taskType, startTime, `Unknown task type: ${input.taskType}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return makeErrorResult(input.taskType, startTime, message);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Task Handlers
// ────────────────────────────────────────────────────────────────────────────

function handleAnalyze(input: WorkerInput, startTime: number): WorkerAnalyzeResult {
  const diagnostics: Diagnostic[] = [];

  // Step 1: Lexer
  const lexResult = tokenize(input.code);
  for (const err of lexResult.errors) {
    diagnostics.push({
      range: {
        startLine: err.line - 1,
        startCol: err.col - 1,
        endLine: err.line - 1,
        endCol: err.col - 1 + err.length,
      },
      severity: 'error',
      message: err.message,
      code: 'STL001',
      source: 'st-lexer',
    });
  }

  // Step 2: Parse
  let ast: ASTNode[] = [];
  try {
    const { STParser } = require('../parser/st-parser');
    const parser = new STParser(lexResult.tokens);
    const parseResult = parser.parse();
    ast = parseResult.ast || [];
    for (const err of parseResult.errors || []) {
      diagnostics.push({
        range: {
          startLine: err.line - 1,
          startCol: err.col - 1,
          endLine: (err.endLine || err.line) - 1,
          endCol: (err.endCol || err.col) - 1,
        },
        severity: err.severity || 'error',
        message: err.message,
        code: err.code || 'STP001',
        source: 'st-parser',
      });
    }
  } catch {
    // Parser not available yet, lexer-only diagnostics
  }

  // Step 3: Semantic analysis
  try {
    const { SemanticAnalyzer } = require('../analyzer/semantic-analyzer');
    const { adaptParserAST } = require('../analyzer/ast-adapter');
    const analyzer = new SemanticAnalyzer();
    const adaptedAST = adaptParserAST(ast);
    const semDiagnostics = analyzer.analyze(adaptedAST);
    if (semDiagnostics && semDiagnostics.length > 0) {
      diagnostics.push(...semDiagnostics);
    }
  } catch {
    // Semantic analyzer not available yet
  }

  // Build outline from AST
  const outline = buildOutline(ast);

  return {
    taskType: 'analyze',
    success: true,
    diagnostics: diagnostics.slice(0, input.limits.maxDiagnostics),
    outline,
    processingTimeMs: performance.now() - startTime,
  };
}

function handleFormat(input: WorkerInput, startTime: number): WorkerFormatResult {
  // Step 1: Lexer
  const lexResult = tokenize(input.code);
  if (lexResult.errors.length > 0) {
    return {
      taskType: 'format',
      success: false,
      processingTimeMs: performance.now() - startTime,
    };
  }

  // Step 2: Parse
  let ast: ASTNode[] = [];
  try {
    const { STParser } = require('../parser/st-parser');
    const parser = new STParser(lexResult.tokens);
    const parseResult = parser.parse();
    if (parseResult.errors && parseResult.errors.length > 0) {
      // Don't format code with parse errors
      return {
        taskType: 'format',
        success: false,
        processingTimeMs: performance.now() - startTime,
      };
    }
    ast = parseResult.ast || [];
  } catch {
    return {
      taskType: 'format',
      success: false,
      processingTimeMs: performance.now() - startTime,
    };
  }

  // Step 3: Format
  const formatter = new STFormatter();
  const formattedCode = formatter.format(ast);

  return {
    taskType: 'format',
    success: true,
    formattedCode,
    processingTimeMs: performance.now() - startTime,
  };
}

function handleOutline(input: WorkerInput, startTime: number): WorkerOutlineResult {
  const lexResult = tokenize(input.code);
  let ast: ASTNode[] = [];

  try {
    const { STParser } = require('../parser/st-parser');
    const parser = new STParser(lexResult.tokens);
    const parseResult = parser.parse();
    ast = parseResult.ast || [];
  } catch {
    // Parser not available
  }

  const outline = buildOutline(ast);

  return {
    taskType: 'outline',
    success: true,
    outline,
    processingTimeMs: performance.now() - startTime,
  };
}

function handleHover(input: WorkerInput, startTime: number): WorkerHoverResult {
  // Hover requires position + parsed AST + symbol table
  // Minimal implementation: return nothing until semantic analyzer is ready
  return {
    taskType: 'hover',
    success: true,
    processingTimeMs: performance.now() - startTime,
  };
}

function handleComplete(input: WorkerInput, startTime: number): WorkerCompleteResult {
  // Completion requires position + parsed AST + symbol table
  // Minimal implementation until IntelliSense service is ready
  return {
    taskType: 'complete',
    success: true,
    completions: [],
    processingTimeMs: performance.now() - startTime,
  };
}

function handleDefinition(input: WorkerInput, startTime: number): WorkerDefinitionResult {
  return {
    taskType: 'definition',
    success: true,
    processingTimeMs: performance.now() - startTime,
  };
}

function handleReferences(input: WorkerInput, startTime: number): WorkerReferencesResult {
  return {
    taskType: 'references',
    success: true,
    references: [],
    processingTimeMs: performance.now() - startTime,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Outline Builder
// ────────────────────────────────────────────────────────────────────────────

function buildOutline(ast: ASTNode[]): OutlineNode[] {
  const nodes: OutlineNode[] = [];

  for (const node of ast) {
    switch (node.kind) {
      case 'program':
        nodes.push({
          name: node.name,
          kind: 'program',
          range: {
            startLine: node.location.startLine - 1,
            startCol: node.location.startCol - 1,
            endLine: node.location.endLine - 1,
            endCol: node.location.endCol - 1,
          },
          children: buildVarBlockOutline(node.varBlocks),
        });
        break;
      case 'functionBlock':
        nodes.push({
          name: node.name,
          kind: 'functionBlock',
          range: {
            startLine: node.location.startLine - 1,
            startCol: node.location.startCol - 1,
            endLine: node.location.endLine - 1,
            endCol: node.location.endCol - 1,
          },
          children: [
            ...buildVarBlockOutline(node.varBlocks),
            ...node.methods.map(m => ({
              name: m.name,
              kind: 'method' as const,
              range: {
                startLine: m.location.startLine - 1,
                startCol: m.location.startCol - 1,
                endLine: m.location.endLine - 1,
                endCol: m.location.endCol - 1,
              },
            })),
            ...node.properties.map(p => ({
              name: p.name,
              kind: 'property' as const,
              range: {
                startLine: p.location.startLine - 1,
                startCol: p.location.startCol - 1,
                endLine: p.location.endLine - 1,
                endCol: p.location.endCol - 1,
              },
            })),
          ],
        });
        break;
      case 'function':
        nodes.push({
          name: node.name,
          kind: 'function',
          detail: `→ ${node.returnType.kind === 'elementaryType' ? node.returnType.name : '...'}`,
          range: {
            startLine: node.location.startLine - 1,
            startCol: node.location.startCol - 1,
            endLine: node.location.endLine - 1,
            endCol: node.location.endCol - 1,
          },
          children: buildVarBlockOutline(node.varBlocks),
        });
        break;
      case 'interface':
        nodes.push({
          name: node.name,
          kind: 'functionBlock',
          detail: 'INTERFACE',
          range: {
            startLine: node.location.startLine - 1,
            startCol: node.location.startCol - 1,
            endLine: node.location.endLine - 1,
            endCol: node.location.endCol - 1,
          },
        });
        break;
      case 'typeDeclaration':
        nodes.push({
          name: node.name,
          kind: node.type.kind === 'structType' ? 'struct' : node.type.kind === 'enumType' ? 'enum' : 'variable',
          range: {
            startLine: node.location.startLine - 1,
            startCol: node.location.startCol - 1,
            endLine: node.location.endLine - 1,
            endCol: node.location.endCol - 1,
          },
        });
        break;
    }
  }

  return nodes;
}

function buildVarBlockOutline(varBlocks: VarBlockNode[]): OutlineNode[] {
  const nodes: OutlineNode[] = [];

  for (const block of varBlocks) {
    const children: OutlineNode[] = block.declarations.map(decl => ({
      name: decl.names.join(', '),
      kind: 'variable' as const,
      detail: decl.type.kind === 'elementaryType' ? decl.type.name : decl.type.kind,
      range: {
        startLine: decl.location.startLine - 1,
        startCol: decl.location.startCol - 1,
        endLine: decl.location.endLine - 1,
        endCol: decl.location.endCol - 1,
      },
    }));

    nodes.push({
      name: block.blockType,
      kind: 'varBlock',
      range: {
        startLine: block.location.startLine - 1,
        startCol: block.location.startCol - 1,
        endLine: block.location.endLine - 1,
        endCol: block.location.endCol - 1,
      },
      children,
    });
  }

  return nodes;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeErrorResult(taskType: string, startTime: number, message: string): WorkerOutput {
  const processingTimeMs = performance.now() - startTime;

  switch (taskType) {
    case 'analyze':
      return { taskType: 'analyze', success: false, diagnostics: [], processingTimeMs };
    case 'format':
      return { taskType: 'format', success: false, processingTimeMs };
    case 'outline':
      return { taskType: 'outline', success: false, outline: [], processingTimeMs };
    case 'hover':
      return { taskType: 'hover', success: false, processingTimeMs };
    case 'complete':
      return { taskType: 'complete', success: false, completions: [], processingTimeMs };
    case 'definition':
      return { taskType: 'definition', success: false, processingTimeMs };
    case 'references':
      return { taskType: 'references', success: false, references: [], processingTimeMs };
    default:
      return { taskType: 'analyze', success: false, diagnostics: [], processingTimeMs };
  }
}
