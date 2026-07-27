/**
 * Source-free browser-safety scan of a generated classic-script plugin IIFE.
 * Shared by build-time bundling evidence and standalone artifact validation.
 */

import { parse, type Node } from "acorn";

const PRIVATE_RENDERER_GLOBALS = new Set([
  "__EXPLODEX_PLUGIN_CATALOG__",
  "__EXPLODEX_PATHS__",
  "__EXPLODEX_BRIDGE__",
  "__explodexAppServerSend",
  "__bcAppServerSend",
  "electron",
  "electronBridge",
]);

const FORBIDDEN_RUNTIME_GLOBALS = new Set([
  "Buffer",
  "Bun",
  "exports",
  "module",
  "process",
  "require",
]);

const GLOBAL_ROOT_NAMES = new Set(["globalThis", "self", "window"]);

type AstNode = Node & {
  readonly [key: string]: unknown;
};

type StaticValue =
  | { readonly kind: "global-root" }
  | { readonly kind: "string"; readonly value: string };

type Scope = {
  readonly parent: Scope | null;
  readonly declared: Set<string>;
  readonly staticValues: Map<string, StaticValue>;
  readonly thisIsGlobal: boolean;
  readonly functionBoundary: boolean;
};

export type BrowserScanResult =
  | { ok: true }
  | {
      ok: false;
      ruleId:
        | "browser.syntax"
        | "browser.private-renderer-global"
        | "browser.runtime-global"
        | "browser.absolute-path";
      message: string;
      marker: string;
      line?: number;
      column?: number;
    };

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function childNodes(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "type" ||
      key === "start" ||
      key === "end" ||
      key === "loc" ||
      key === "range"
    ) {
      continue;
    }
    if (isAstNode(value)) {
      children.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) children.push(item);
      }
    }
  }
  return children;
}

function identifierName(node: AstNode | null | undefined): string | null {
  if (node?.type !== "Identifier") return null;
  return typeof node.name === "string" ? node.name : null;
}

function declarePattern(node: AstNode | null | undefined, scope: Scope): void {
  if (node === null || node === undefined) return;
  if (node.type === "Identifier") {
    const name = identifierName(node);
    if (name !== null) scope.declared.add(name);
    return;
  }
  if (node.type === "RestElement") {
    declarePattern(isAstNode(node.argument) ? node.argument : null, scope);
    return;
  }
  if (node.type === "AssignmentPattern") {
    declarePattern(isAstNode(node.left) ? node.left : null, scope);
    return;
  }
  if (node.type === "ArrayPattern" && Array.isArray(node.elements)) {
    for (const element of node.elements) {
      declarePattern(isAstNode(element) ? element : null, scope);
    }
    return;
  }
  if (node.type === "ObjectPattern" && Array.isArray(node.properties)) {
    for (const property of node.properties) {
      if (!isAstNode(property)) continue;
      if (property.type === "Property") {
        declarePattern(isAstNode(property.value) ? property.value : null, scope);
      } else if (property.type === "RestElement") {
        declarePattern(isAstNode(property.argument) ? property.argument : null, scope);
      }
    }
  }
}

function declarationScope(scope: Scope, kind: unknown): Scope {
  if (kind !== "var") return scope;
  let cursor = scope;
  while (!cursor.functionBoundary && cursor.parent !== null) {
    cursor = cursor.parent;
  }
  return cursor;
}

function invalidatePattern(node: AstNode | null | undefined, scope: Scope): void {
  if (node === null || node === undefined) return;
  if (node.type === "Identifier") {
    const name = identifierName(node);
    const binding = name === null ? null : resolveBinding(scope, name);
    if (name !== null && binding !== null) binding.staticValues.delete(name);
    return;
  }
  if (node.type === "RestElement") {
    invalidatePattern(isAstNode(node.argument) ? node.argument : null, scope);
    return;
  }
  if (node.type === "AssignmentPattern") {
    invalidatePattern(isAstNode(node.left) ? node.left : null, scope);
    return;
  }
  if (node.type === "ArrayPattern" && Array.isArray(node.elements)) {
    for (const element of node.elements) {
      invalidatePattern(isAstNode(element) ? element : null, scope);
    }
    return;
  }
  if (node.type === "ObjectPattern" && Array.isArray(node.properties)) {
    for (const property of node.properties) {
      if (!isAstNode(property)) continue;
      if (property.type === "Property") {
        invalidatePattern(isAstNode(property.value) ? property.value : null, scope);
      } else if (property.type === "RestElement") {
        invalidatePattern(isAstNode(property.argument) ? property.argument : null, scope);
      }
    }
  }
}

function predeclareBody(node: AstNode, scope: Scope): void {
  const body = Array.isArray(node.body) ? node.body : [];
  for (const statement of body) {
    if (!isAstNode(statement)) continue;
    if (
      statement.type === "FunctionDeclaration" ||
      statement.type === "ClassDeclaration"
    ) {
      declarePattern(isAstNode(statement.id) ? statement.id : null, scope);
      continue;
    }
    if (statement.type === "VariableDeclaration" && Array.isArray(statement.declarations)) {
      const target = declarationScope(scope, statement.kind);
      for (const declaration of statement.declarations) {
        if (!isAstNode(declaration)) continue;
        declarePattern(isAstNode(declaration.id) ? declaration.id : null, target);
      }
    }
  }
}

function resolveBinding(scope: Scope, name: string): Scope | null {
  let cursor: Scope | null = scope;
  while (cursor !== null) {
    if (cursor.declared.has(name)) return cursor;
    cursor = cursor.parent;
  }
  return null;
}

function staticValueForIdentifier(scope: Scope, name: string): StaticValue | null {
  const binding = resolveBinding(scope, name);
  return binding?.staticValues.get(name) ?? null;
}

function staticString(node: AstNode | null | undefined, scope: Scope): string | null {
  if (node === null || node === undefined) return null;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    node.type === "TemplateLiteral" &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0 &&
    Array.isArray(node.quasis) &&
    node.quasis.length === 1
  ) {
    const quasi = node.quasis[0];
    if (isAstNode(quasi) && typeof quasi.value === "object" && quasi.value !== null) {
      const cooked = (quasi.value as { cooked?: unknown }).cooked;
      return typeof cooked === "string" ? cooked : null;
    }
  }
  if (
    node.type === "BinaryExpression" &&
    node.operator === "+" &&
    isAstNode(node.left) &&
    isAstNode(node.right)
  ) {
    const left = staticString(node.left, scope);
    const right = staticString(node.right, scope);
    return left !== null && right !== null ? left + right : null;
  }
  if (node.type === "Identifier") {
    const name = identifierName(node);
    const value = name === null ? null : staticValueForIdentifier(scope, name);
    return value?.kind === "string" ? value.value : null;
  }
  if (
    node.type === "ConditionalExpression" &&
    isAstNode(node.consequent) &&
    isAstNode(node.alternate)
  ) {
    const consequent = staticString(node.consequent, scope);
    const alternate = staticString(node.alternate, scope);
    return consequent !== null && consequent === alternate ? consequent : null;
  }
  return null;
}

function isGlobalRoot(node: AstNode | null | undefined, scope: Scope): boolean {
  if (node?.type === "ChainExpression" && isAstNode(node.expression)) {
    return isGlobalRoot(node.expression, scope);
  }
  if (
    node?.type === "SequenceExpression" &&
    Array.isArray(node.expressions) &&
    node.expressions.length > 0
  ) {
    const last = node.expressions[node.expressions.length - 1];
    return isAstNode(last) && isGlobalRoot(last, scope);
  }
  if (node?.type === "ThisExpression") return scope.thisIsGlobal;
  if (node?.type !== "Identifier") return false;
  const name = identifierName(node);
  if (name === null) return false;
  const binding = resolveBinding(scope, name);
  if (binding === null) return GLOBAL_ROOT_NAMES.has(name);
  return binding.staticValues.get(name)?.kind === "global-root";
}

function memberPropertyName(node: AstNode, scope: Scope): string | null {
  if (node.type !== "MemberExpression" && node.type !== "PropertyDefinition") {
    return null;
  }
  const property = isAstNode(node.property) ? node.property : null;
  if (property === null) return null;
  if (node.computed === true) return staticString(property, scope);
  return identifierName(property);
}

function locationOf(node: AstNode): { line?: number; column?: number } {
  if (typeof node.loc !== "object" || node.loc === null) return {};
  const start = (node.loc as { start?: unknown }).start;
  if (typeof start !== "object" || start === null) return {};
  const line = (start as { line?: unknown }).line;
  const column = (start as { column?: unknown }).column;
  return {
    ...(typeof line === "number" ? { line } : {}),
    ...(typeof column === "number" ? { column } : {}),
  };
}

function violation(
  node: AstNode,
  ruleId:
    | "browser.private-renderer-global"
    | "browser.runtime-global"
    | "browser.absolute-path",
  marker: string,
  message: string,
): BrowserScanResult {
  return {
    ok: false,
    ruleId,
    marker,
    message,
    ...locationOf(node),
  };
}

function isIdentifierReference(node: AstNode, parent: AstNode | null): boolean {
  if (parent === null) return true;
  if (
    (parent.type === "VariableDeclarator" && parent.id === node) ||
    ((parent.type === "FunctionDeclaration" ||
      parent.type === "FunctionExpression" ||
      parent.type === "ArrowFunctionExpression") &&
      (parent.id === node ||
        (Array.isArray(parent.params) && parent.params.includes(node)))) ||
    ((parent.type === "ClassDeclaration" || parent.type === "ClassExpression") &&
      parent.id === node) ||
    (parent.type === "Property" && parent.key === node && parent.computed !== true) ||
    (parent.type === "MemberExpression" && parent.property === node && parent.computed !== true) ||
    (parent.type === "LabeledStatement" && parent.label === node) ||
    (parent.type === "BreakStatement" && parent.label === node) ||
    (parent.type === "ContinueStatement" && parent.label === node)
  ) {
    return false;
  }
  return true;
}

/**
 * Reject forbidden Node/Bun/Electron/private-renderer primitives in installable JS.
 * Does not execute the bundle.
 */
export function scanBrowserSafeIife(source: string): BrowserScanResult {
  let program: AstNode;
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      locations: true,
      allowHashBang: true,
    }) as unknown as AstNode;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid classic-script syntax";
    return {
      ok: false,
      ruleId: "browser.syntax",
      message: `Plugin bundle is not valid classic-script JavaScript: ${message}`,
      marker: "syntax",
    };
  }

  const rootScope: Scope = {
    parent: null,
    declared: new Set<string>(),
    staticValues: new Map<string, StaticValue>(),
    thisIsGlobal: true,
    functionBoundary: true,
  };
  predeclareBody(program, rootScope);

  function visit(node: AstNode, scope: Scope, parent: AstNode | null): BrowserScanResult {
    if (node.type === "Program" || node.type === "BlockStatement") {
      const blockScope =
        node.type === "Program"
          ? scope
          : {
              parent: scope,
              declared: new Set<string>(),
              staticValues: new Map<string, StaticValue>(),
              thisIsGlobal: scope.thisIsGlobal,
              functionBoundary: false,
            };
      predeclareBody(node, blockScope);
      const body = Array.isArray(node.body) ? node.body : [];
      for (const statement of body) {
        if (!isAstNode(statement)) continue;
        const result = visit(statement, blockScope, node);
        if (!result.ok) return result;
      }
      return { ok: true };
    }

    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      const functionScope: Scope = {
        parent: scope,
        declared: new Set<string>(),
        staticValues: new Map<string, StaticValue>(),
        thisIsGlobal:
          node.type === "ArrowFunctionExpression"
            ? scope.thisIsGlobal
            : !(
                (parent?.type === "Property" && parent.value === node) ||
                parent?.type === "MethodDefinition" ||
                (isAstNode(node.body) &&
                  Array.isArray(node.body.body) &&
                  node.body.body.some(
                    (statement) =>
                      isAstNode(statement) &&
                      statement.type === "ExpressionStatement" &&
                      typeof statement.directive === "string" &&
                      statement.directive === "use strict",
                  ))
              ),
        functionBoundary: true,
      };
      if (node.type !== "ArrowFunctionExpression") {
        declarePattern(isAstNode(node.id) ? node.id : null, functionScope);
      }
      if (Array.isArray(node.params)) {
        for (const parameter of node.params) {
          declarePattern(isAstNode(parameter) ? parameter : null, functionScope);
        }
      }
      if (isAstNode(node.body)) {
        return visit(node.body, functionScope, node);
      }
      return { ok: true };
    }

    if (node.type === "VariableDeclarator") {
      const id = isAstNode(node.id) ? node.id : null;
      const init = isAstNode(node.init) ? node.init : null;
      const targetScope = declarationScope(
        scope,
        parent?.type === "VariableDeclaration" ? parent.kind : null,
      );
      declarePattern(id, targetScope);
      if (init !== null) {
        const initResult = visit(init, scope, node);
        if (!initResult.ok) return initResult;
      }
      const name = identifierName(id);
      if (name !== null && init !== null) {
        if (isGlobalRoot(init, scope)) {
          targetScope.staticValues.set(name, { kind: "global-root" });
        } else {
          const value = staticString(init, scope);
          if (value !== null) {
            targetScope.staticValues.set(name, { kind: "string", value });
          }
        }
      }
      if (id?.type === "ObjectPattern" && init !== null && isGlobalRoot(init, scope)) {
        const properties = Array.isArray(id.properties) ? id.properties : [];
        for (const property of properties) {
          if (!isAstNode(property) || property.type !== "Property") continue;
          const propertyName =
            property.computed === true
              ? staticString(isAstNode(property.key) ? property.key : null, scope)
              : identifierName(isAstNode(property.key) ? property.key : null);
          if (propertyName !== null && PRIVATE_RENDERER_GLOBALS.has(propertyName)) {
            return violation(
              property,
              "browser.private-renderer-global",
              propertyName,
              `Plugin bundle references forbidden private renderer global: ${propertyName}`,
            );
          }
          if (propertyName !== null && FORBIDDEN_RUNTIME_GLOBALS.has(propertyName)) {
            return violation(
              property,
              "browser.runtime-global",
              propertyName,
              `Plugin bundle references forbidden runtime global: ${propertyName}`,
            );
          }
        }
      }
      return { ok: true };
    }

    if (
      node.type === "AssignmentExpression" &&
      isAstNode(node.left) &&
      isAstNode(node.right)
    ) {
      const rightResult = visit(node.right, scope, node);
      if (!rightResult.ok) return rightResult;
      const name = identifierName(node.left);
      const binding = name === null ? null : resolveBinding(scope, name);
      if (name !== null && binding !== null) {
        if (node.operator === "=" && isGlobalRoot(node.right, scope)) {
          binding.staticValues.set(name, { kind: "global-root" });
        } else if (node.operator === "=") {
          const value = staticString(node.right, scope);
          if (value !== null) {
            binding.staticValues.set(name, { kind: "string", value });
          } else {
            binding.staticValues.delete(name);
          }
        } else {
          binding.staticValues.delete(name);
        }
      }
      if (
        node.operator === "=" &&
        node.left.type === "ObjectPattern" &&
        isGlobalRoot(node.right, scope)
      ) {
        const properties = Array.isArray(node.left.properties)
          ? node.left.properties
          : [];
        for (const property of properties) {
          if (!isAstNode(property) || property.type !== "Property") continue;
          const propertyName =
            property.computed === true
              ? staticString(isAstNode(property.key) ? property.key : null, scope)
              : identifierName(isAstNode(property.key) ? property.key : null);
          if (propertyName !== null && PRIVATE_RENDERER_GLOBALS.has(propertyName)) {
            return violation(
              property,
              "browser.private-renderer-global",
              propertyName,
              `Plugin bundle references forbidden private renderer global: ${propertyName}`,
            );
          }
          if (propertyName !== null && FORBIDDEN_RUNTIME_GLOBALS.has(propertyName)) {
            return violation(
              property,
              "browser.runtime-global",
              propertyName,
              `Plugin bundle references forbidden runtime global: ${propertyName}`,
            );
          }
        }
      }
      if (node.left.type !== "Identifier") {
        invalidatePattern(node.left, scope);
      }
      return visit(node.left, scope, node);
    }

    if (node.type === "UpdateExpression" && isAstNode(node.argument)) {
      invalidatePattern(node.argument, scope);
      return visit(node.argument, scope, node);
    }

    if (node.type === "CatchClause") {
      const catchScope: Scope = {
        parent: scope,
        declared: new Set<string>(),
        staticValues: new Map<string, StaticValue>(),
        thisIsGlobal: scope.thisIsGlobal,
        functionBoundary: false,
      };
      declarePattern(isAstNode(node.param) ? node.param : null, catchScope);
      if (isAstNode(node.body)) return visit(node.body, catchScope, node);
      return { ok: true };
    }

    if (node.type === "CallExpression" && isAstNode(node.callee)) {
      const calleeObject =
        node.callee.type === "MemberExpression" && isAstNode(node.callee.object)
          ? node.callee.object
          : null;
      const calleeProperty =
        node.callee.type === "MemberExpression"
          ? memberPropertyName(node.callee, scope)
          : null;
      const reflectName = identifierName(calleeObject);
      if (
        reflectName === "Reflect" &&
        resolveBinding(scope, reflectName) === null &&
        (calleeProperty === "get" ||
          calleeProperty === "has" ||
          calleeProperty === "getOwnPropertyDescriptor") &&
        Array.isArray(node.arguments)
      ) {
        const target = isAstNode(node.arguments[0]) ? node.arguments[0] : null;
        const property = isAstNode(node.arguments[1]) ? node.arguments[1] : null;
        const propertyName = staticString(property, scope);
        if (target !== null && isGlobalRoot(target, scope) && propertyName !== null) {
          if (PRIVATE_RENDERER_GLOBALS.has(propertyName)) {
            return violation(
              node,
              "browser.private-renderer-global",
              propertyName,
              `Plugin bundle references forbidden private renderer global: ${propertyName}`,
            );
          }
          if (FORBIDDEN_RUNTIME_GLOBALS.has(propertyName)) {
            return violation(
              node,
              "browser.runtime-global",
              propertyName,
              `Plugin bundle references forbidden runtime global: ${propertyName}`,
            );
          }
        }
      }
      const objectName = identifierName(calleeObject);
      if (
        objectName === "Object" &&
        resolveBinding(scope, objectName) === null &&
        (calleeProperty === "getOwnPropertyDescriptor" ||
          calleeProperty === "hasOwn") &&
        Array.isArray(node.arguments)
      ) {
        const target = isAstNode(node.arguments[0]) ? node.arguments[0] : null;
        const property = isAstNode(node.arguments[1]) ? node.arguments[1] : null;
        const propertyName = staticString(property, scope);
        if (target !== null && isGlobalRoot(target, scope) && propertyName !== null) {
          if (PRIVATE_RENDERER_GLOBALS.has(propertyName)) {
            return violation(
              node,
              "browser.private-renderer-global",
              propertyName,
              `Plugin bundle references forbidden private renderer global: ${propertyName}`,
            );
          }
          if (FORBIDDEN_RUNTIME_GLOBALS.has(propertyName)) {
            return violation(
              node,
              "browser.runtime-global",
              propertyName,
              `Plugin bundle references forbidden runtime global: ${propertyName}`,
            );
          }
        }
      }
    }

    if (node.type === "Identifier" && isIdentifierReference(node, parent)) {
      const name = identifierName(node);
      if (name !== null && resolveBinding(scope, name) === null) {
        if (PRIVATE_RENDERER_GLOBALS.has(name)) {
          return violation(
            node,
            "browser.private-renderer-global",
            name,
            `Plugin bundle references forbidden private renderer global: ${name}`,
          );
        }
        if (FORBIDDEN_RUNTIME_GLOBALS.has(name)) {
          return violation(
            node,
            "browser.runtime-global",
            name,
            `Plugin bundle references forbidden runtime global: ${name}`,
          );
        }
      }
    }

    if (node.type === "MemberExpression") {
      const object = isAstNode(node.object) ? node.object : null;
      const propertyName = memberPropertyName(node, scope);
      if (object !== null && isGlobalRoot(object, scope) && propertyName !== null) {
        if (PRIVATE_RENDERER_GLOBALS.has(propertyName)) {
          return violation(
            node,
            "browser.private-renderer-global",
            propertyName,
            `Plugin bundle references forbidden private renderer global: ${propertyName}`,
          );
        }
        if (FORBIDDEN_RUNTIME_GLOBALS.has(propertyName)) {
          return violation(
            node,
            "browser.runtime-global",
            propertyName,
            `Plugin bundle references forbidden runtime global: ${propertyName}`,
          );
        }
      }
    }

    if (node.type === "Literal" && typeof node.value === "string") {
      if (/^\/(?:Users|home|var|tmp|private)\//.test(node.value)) {
        return violation(
          node,
          "browser.absolute-path",
          "absolute-path",
          "Plugin bundle embeds non-portable absolute filesystem paths",
        );
      }
    }
    if (node.type === "TemplateLiteral") {
      const value = staticString(node, scope);
      if (value !== null && /^\/(?:Users|home|var|tmp|private)\//.test(value)) {
        return violation(
          node,
          "browser.absolute-path",
          "absolute-path",
          "Plugin bundle embeds non-portable absolute filesystem paths",
        );
      }
    }

    for (const child of childNodes(node)) {
      const result = visit(child, scope, node);
      if (!result.ok) return result;
    }
  return { ok: true };
  }

  return visit(program, rootScope, null);
}
