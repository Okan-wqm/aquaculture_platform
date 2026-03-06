export { SymbolTable, elementary } from './symbol-table';
export type {
  DataType,
  ElementaryType,
  ArrayType,
  StructType,
  StructField,
  EnumType,
  FunctionBlockType,
  FBParameter,
  FunctionParameter,
  Symbol,
  SymbolKind,
  VariableScope,
  ScopeKind,
} from './symbol-table';

export { TypeChecker } from './type-checker';

export { SemanticAnalyzer } from './semantic-analyzer';
export type {
  ASTNode,
  POUDecl,
  ProgramDecl,
  FunctionDecl,
  FunctionBlockDecl,
  Statement,
  Expression,
  VarBlock,
  VarDeclaration,
} from './semantic-analyzer';
