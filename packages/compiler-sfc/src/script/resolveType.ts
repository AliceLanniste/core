import {
  Node,
  Statement,
  TSInterfaceBody,
  TSType,
  TSTypeElement
} from '@babel/types'

import { ScriptCompileContext } from './context'
import { FromNormalScript, UNKNOWN_TYPE } from './utils'

export function resolveQualifiedType(
  ctx: ScriptCompileContext,
  node: Node,
  qualifier: (node: Node) => boolean
) {
  if (qualifier(node)) {
    return node
  }
  if (node.type === 'TSTypeReference' && node.typeName.type === 'Identifier') {
    const refName = node.typeName.name
    const { scriptAST, scriptSetupAST } = ctx

    const body = scriptAST
      ? [...scriptSetupAST!.body, ...scriptAST.body]
      : scriptSetupAST!.body

    for (let i = 0; i < body.length; i++) {
      const node = body[i]
      let qualified = isQualifiedType(
        node,
        qualifier,
        refName
      ) as TSInterfaceBody

      if (qualified) {
        const extendsTypes = resolveExtendsType(body, node, qualifier)
        if (extendsTypes.length) {
          const bodies: TSTypeElement[] = [...qualified.body]
          filterExtendsType(extendsTypes, bodies)
          qualified.body = bodies
        }
        ;(qualified as FromNormalScript<Node>).__fromNormalScript =
          scriptAST && i >= scriptSetupAST!.body.length
        return qualified
      }
    }
  }
}

function isQualifiedType(
  node: Node,
  qualifier: (node: Node) => boolean,
  refName: string
): Node | undefined {
  if (node.type === 'TSInterfaceDeclaration' && node.id.name === refName) {
    return node.body
  } else if (
    node.type === 'TSTypeAliasDeclaration' &&
    node.id.name === refName &&
    qualifier(node.typeAnnotation)
  ) {
    return node.typeAnnotation
  } else if (node.type === 'ExportNamedDeclaration' && node.declaration) {
    return isQualifiedType(node.declaration, qualifier, refName)
  }
}

function resolveExtendsType(
  body: Statement[],
  node: Statement,
  qualifier: (node: Node) => boolean,
  cache: Array<Node> = []
): Array<Node> {
  if (node.type === 'TSInterfaceDeclaration' && node.extends) {
    node.extends.forEach(extend => {
      if (
        extend.type === 'TSExpressionWithTypeArguments' &&
        extend.expression.type === 'Identifier'
      ) {
        for (const node of body) {
          const qualified = isQualifiedType(
            node,
            qualifier,
            extend.expression.name
          )
          if (qualified) {
            cache.push(qualified)
            resolveExtendsType(body, node, qualifier, cache)
            return cache
          }
        }
      }
    })
  }
  return cache
}
// filter all extends types to keep the override declaration
function filterExtendsType(extendsTypes: Node[], bodies: TSTypeElement[]) {
  extendsTypes.forEach(extend => {
    const body = (extend as TSInterfaceBody).body
    body.forEach(newBody => {
      if (
        newBody.type === 'TSPropertySignature' &&
        newBody.key.type === 'Identifier'
      ) {
        const name = newBody.key.name
        const hasOverride = bodies.some(
          seenBody =>
            seenBody.type === 'TSPropertySignature' &&
            seenBody.key.type === 'Identifier' &&
            seenBody.key.name === name
        )
        if (!hasOverride) {
          bodies.push(newBody)
        }
      }
    })
  })
}

/**
 * 这个函数作用是让definProps<TypeParameter>(),将@param TypeParameter转换成js的type
 */
export function inferRuntimeType(
  node: TSType,
  declaredTypes: Record<string, string[]>
): string[] {
  switch (node.type) {
    case 'TSStringKeyword':
      return ['String']
    case 'TSNumberKeyword':
      return ['Number']
    case 'TSBooleanKeyword':
      return ['Boolean']
    case 'TSObjectKeyword':
      return ['Object']
    case 'TSNullKeyword':
      return ['null']
    case 'TSTypeLiteral': {
      // TODO (nice to have) generate runtime property validation
      const types = new Set<string>()
      for (const m of node.members) {
        if (
          m.type === 'TSCallSignatureDeclaration' ||
          m.type === 'TSConstructSignatureDeclaration'
        ) {
          types.add('Function')
        } else {
          types.add('Object')
        }
      }
      return types.size ? Array.from(types) : ['Object']
    }

    case 'TSFunctionType':
      return ['Function']
    case 'TSArrayType':
    case 'TSTupleType':
      // TODO (nice to have) generate runtime element type/length checks
      return ['Array']

    case 'TSLiteralType':
      switch (node.literal.type) {
        case 'StringLiteral':
          return ['String']
        case 'BooleanLiteral':
          return ['Boolean']
        case 'NumericLiteral':
        case 'BigIntLiteral':
          return ['Number']

        default:
          return [UNKNOWN_TYPE]
      }

    case 'TSTypeReference':
      if (node.typeName.type === 'Identifier') {
        if (declaredTypes[node.typeName.type]) {
          return declaredTypes[node.typeName.type]
        }
        switch (node.typeName.name) {
          case 'Array':
          case 'Function':
          case 'Object':
          case 'Set':
          case 'Map':
          case 'WeakSet':
          case 'WeakMap':
          case 'Date':
          case 'Promise':
            return [node.typeName.name]
          // TS built-in utility types
          // https://www.typescriptlang.org/docs/handbook/utility-types.html
          case 'Partial':
          case 'Required':
          case 'ReadOnly':
          case 'Record':
          case 'Pick':
          case 'Omit':
          case 'InstanceType':
            return ['Object']

          case 'Uppercase':
          case 'Lowercase':
          case 'Capitalize':
          case 'Uncapitalize':
            return ['String']

          case 'Parameters':
          case 'ConstructorParameters':
            return ['Array']

          case 'NonNullable':
            if (node.typeParameters && node.typeParameters.params[0]) {
              return inferRuntimeType(
                node.typeParameters.params[0],
                declaredTypes
              ).filter(t => t !== 'null')
            }

            break

          case 'Extract':
            if (node.typeParameters && node.typeParameters.params[1]) {
              return inferRuntimeType(
                node.typeParameters.params[1],
                declaredTypes
              )
            }
            break
          case 'Exclude':
          case 'OmitThisParameter':
            if (node.typeParameters && node.typeParameters.params[0]) {
              return inferRuntimeType(
                node.typeParameters.params[0],
                declaredTypes
              )
            }
            break
        }
      }
      // cannot infer, fallback to UNKNOWN: ThisParameterType
      return [UNKNOWN_TYPE]

    case 'TSParenthesizedType':
      return inferRuntimeType(node.typeAnnotation, declaredTypes)

    case 'TSUnionType':
      return flattenTypes(node.types, declaredTypes)
    case 'TSIntersectionType': {
      return flattenTypes(node.types, declaredTypes).filter(
        t => t !== UNKNOWN_TYPE
      )
    }
    case 'TSSymbolKeyword':
      return ['Symbol']

    default:
      return [UNKNOWN_TYPE]
  }
}

function flattenTypes(
  types: TSType[],
  declaredTypes: Record<string, string[]>
): string[] {
  return [
    ...new Set(
      ([] as string[]).concat(
        ...types.map(t => inferRuntimeType(t, declaredTypes))
      )
    )
  ]
}
