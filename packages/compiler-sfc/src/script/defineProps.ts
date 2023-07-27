import {
  Node,
  LVal,
  TSTypeLiteral,
  TSInterfaceBody,
  Identifier,
  Expression,
  ObjectExpression,
  ObjectProperty,
  ObjectMethod
} from '@babel/types'
import { ScriptCompileContext } from './context'
import { isFunctionType } from '@vue/compiler-dom'
import { isCallOf, unwrapTSNode } from './utils'
import { inferRuntimeType, resolveQualifiedType } from './resolveType'
import {
  resolveObjectKey,
  FromNormalScript,
  UNKNOWN_TYPE,
  isLiteralNode,
  concatStrings,
  toRunTimeTypeString
} from './utils'
import { genModels } from './defineModel'

export const DEFINE_PROPS = 'defineProps'
export const WITH_DEFAULTS = 'withDefaults'

export type PropsDeclType = FromNormalScript<TSTypeLiteral | TSInterfaceBody>

export interface PropTypeData {
  key: string
  type: string[]
  required: boolean
  skipCheck: boolean
}

export type PropsDestructureBindings = Record<
  string, //public prop key
  {
    local: string //local identifier,
    default?: Expression
  }
>
/**
 * 用来解析defineProps(arguments)/ defineProps<TypeParameter>()
 * node可以是arguments和TypeParameter
 * declI const { } = defineProps<{ }>() { }这部分
 */
export function processDefineProps(
  ctx: ScriptCompileContext,
  node: Node,
  declId?: LVal
) {
  if (!isCallOf(node, DEFINE_PROPS)) {
    return processWithDefaults(ctx, node, declId)
  }

  if (ctx.hasDefinePropsCall) {
    ctx.error(`duplicate ${DEFINE_PROPS}() call`, node)
  }
  ctx.hasDefinePropsCall = true
  ctx.propsRuntimeDecl = node.arguments[0]

  // call has type parameters - infer runtime types from it
  if (node.typeParameters) {
    if (ctx.propsRuntimeDecl) {
      ctx.error(
        `${DEFINE_PROPS}() cannot accept both type and non-type arguments ` +
          `at the same time. Use one or the other.`,
        node
      )
    }

    const rawDecl = node.typeParameters.params[0]
    ctx.propsTypeDecl = resolveQualifiedType(
      ctx,
      rawDecl,
      node => node.type === 'TSTypeLiteral'
    ) as PropsDeclType | undefined

    if (!ctx.propsTypeDecl) {
      ctx.error(
        `type argument passed to ${DEFINE_PROPS}() must be a literal type, ` +
          `or a reference to an interface or literal type.`,
        node
      )
    }
  }

  if (declId) {
    //handle props destructure
    if (declId.type === 'ObjectPattern') {
      ctx.propsDestructureDecl = declId
      for (const prop of declId.properties) {
        if (prop.type === 'ObjectProperty') {
          const propKey = resolveObjectKey(prop.key, prop.computed)
          // console.log('propkey', propKey)
          if (!propKey) {
            ctx.error(
              `${DEFINE_PROPS}() destructure cannot use computed key.`,
              prop.key
            )
          }
          if (prop.value.type === 'AssignmentExpression') {
            const { left, right } = prop.value
            if (left.type !== 'Identifier') {
              ctx.error(
                `${DEFINE_PROPS}() destructure does not support nested patterns.`,
                left
              )
            }
            //store default value
            ctx.propsDestructuredBindings[propKey] = {
              local: left.name,
              default: right
            }
          } else if (prop.value.type === 'Identifier') {
            ctx.propsDestructuredBindings[propKey] = {
              local: prop.value.name
            }
          } else {
            ctx.error(
              `${DEFINE_PROPS}() destructure does not support nested patterns.`,
              prop.value
            )
          }
        } else {
          //rest spread
          ctx.propsDestructureRestId = (prop.argument as Identifier).name
        }
      }
    } else {
      ctx.propsIdentifier = ctx.getString(declId)
    }
  }

  return true
}

export function processWithDefaults(
  ctx: ScriptCompileContext,
  node: Node,
  declId?: LVal
) {
  if (!isCallOf(node, WITH_DEFAULTS)) {
    return false
  }

  if (processDefineProps(ctx, node.arguments[0], declId)) {
    if (ctx.propsRuntimeDecl) {
      ctx.error(
        `${WITH_DEFAULTS} can only be used with type-base` +
          `${DEFINE_PROPS} declaration.`,
        node
      )
    }

    if (ctx.propsDestructureDecl) {
      ctx.error(
        `${WITH_DEFAULTS}() is unnecessary when using destructure with ${DEFINE_PROPS}().\n` +
          `Prefer using destructure default values, e.g. const { foo = 1 } = defineProps(...).`,
        node.callee
      )
    }

    ctx.propsRuntimeDefaults = node.arguments[1]
    if (!ctx.propsRuntimeDefaults) {
      ctx.error(
        `${WITH_DEFAULTS} first argument must be a ${DEFINE_PROPS} call.`,
        node.arguments[0] || node
      )
    }
  } else {
  }
  return true
}

export function extractRuntimeProps(ctx: ScriptCompileContext) {
  const node = ctx.propsTypeDecl
  if (!node) return
  // console.log('extractRuntimeProps',node)
  const members = node.type === 'TSTypeLiteral' ? node.members : node.body
  for (const member of members) {
    if (
      (member.type === 'TSPropertySignature' ||
        member.type === 'TSMethodSignature') &&
      member.key.type === 'Identifier'
    ) {
      let type: string[] | undefined
      let skipCheck = false
      if (member.type === 'TSMethodSignature') {
        console.log('TSMethodSignature', member.key.name)
        type = ['Function']
      } else if (member.typeAnnotation) {
        console.log('typeAnntation', member.key.name)
        type = inferRuntimeType(
          member.typeAnnotation.typeAnnotation,
          ctx.declaredTypes
        )
        //skip check for result containing unknowm types
        if (type?.includes(UNKNOWN_TYPE)) {
          if (type.includes('Boolean') || type.includes('Function')) {
            type = type.filter(t => t !== UNKNOWN_TYPE)
            skipCheck = true
          } else {
            type = ['null']
          }
        }
      }
      ctx.typeDeclaredProps[member.key.name] = {
        key: member.key.name,
        required: !member.optional,
        type: type || [`null`],
        skipCheck
      }
    }
  }

  console.log('typeDeclar', ctx.typeDeclaredProps)
}

export function genRuntimeProps(ctx: ScriptCompileContext): string | undefined {
  let propsDecls: undefined | string
  if (ctx.propsRuntimeDecl) {
    propsDecls = ctx.getString(ctx.propsRuntimeDecl).trim()
    if (ctx.propsDestructureDecl) {
      const defaults: string[] = []
      for (const key in ctx.propsDestructuredBindings) {
        const d = genDestructuredDefaultValue(ctx, key)
        if (d)
          defaults.push(
            `${key}:${d.valueString}${
              d.needSkipFactory ? `__skip${key}:true` : ``
            }`
          )
      }
      if (defaults.length) {
        propsDecls = `${ctx.helper(
          `mergeDefaults`
        )}(${propsDecls},{\n ${defaults.join(',\n  ')} \n})`
      }
    }
  } else if (ctx.propsTypeDecl) {
    propsDecls = genPropsFromTS(ctx)
  }
  const modelsDecls = genModels(ctx)

  if (propsDecls && modelsDecls) {
    return `${ctx.helper('mergeModels')}(${propsDecls},${modelsDecls})`
  } else {
    return modelsDecls || propsDecls
  }
}

function genDestructuredDefaultValue(
  ctx: ScriptCompileContext,
  key: string,
  inferredType?: string[]
):
  | {
      valueString: string
      needSkipFactory: boolean
    }
  | undefined {
  const destructured = ctx.propsDestructuredBindings[key]
  const defaultVal = destructured && destructured.default
  if (defaultVal) {
    const value = ctx.getString(defaultVal)
    const unwrapped = unwrapTSNode(defaultVal)

    if (
      inferredType &&
      inferredType.length &&
      !inferredType.includes(UNKNOWN_TYPE)
    ) {
      const valueType = inferValueType(unwrapped)
      if (valueType && !inferredType.includes(valueType)) {
        ctx.error(
          `Default value of prop "${key}" does not match declared type.`,
          unwrapped
        )
      }
    }

    const needSkipFactory =
      !inferredType &&
      (isFunctionType(unwrapped) || unwrapped.type === 'Identifier')

    const needFactoryWrap =
      !needSkipFactory &&
      !isLiteralNode(unwrapped) &&
      !inferredType?.includes('Function')

    return {
      valueString: needFactoryWrap ? `()=>(${value})` : value,
      needSkipFactory
    }
  }
}

// non-comprehensive, best-effort type infernece for a runtime value
// this is used to catch default value / type declaration mismatches
// when using props destructure.
function inferValueType(node: Node): string | undefined {
  switch (node.type) {
    case 'StringLiteral':
      return 'String'
    case 'NumberLiteral':
      return 'Number'
    case 'BooleanLiteral':
      return 'Boolean'
    case 'ObjectExpression':
      return 'Object'
    case 'ArrayExpression':
      return 'Array'
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return 'Function'
  }
}

function genPropsFromTS(ctx: ScriptCompileContext) {
  const keys = Object.keys(ctx.typeDeclaredProps)
  if (!keys.length) return

  const hasStaticDefaults = hasStaticWithDefaults(ctx)
  let propsDecls = `{
            ${keys
              .map(key => {
                let defaultString: string | undefined
                const destructured = genDestructuredDefaultValue(
                  ctx,
                  key,
                  ctx.typeDeclaredProps[key].type
                )
                if (destructured) {
                  defaultString = `default: ${destructured.valueString}${
                    destructured.needSkipFactory ? `, skipFactory: true` : ``
                  }`
                } else if (hasStaticDefaults) {
                  const prop = (
                    ctx.propsRuntimeDefaults as ObjectExpression
                  ).properties.find(node => {
                    if (node.type === 'SpreadElement') return false
                    return resolveObjectKey(node.key, node.computed) === key
                  }) as ObjectProperty | ObjectMethod
                  if (prop) {
                    if (prop.type === 'ObjectProperty') {
                      // prop has corresponding static default value
                      defaultString = `default: ${ctx.getString(prop.value)}`
                    } else {
                      defaultString = `${prop.async ? 'async ' : ''}${
                        prop.kind !== 'method' ? `${prop.key} ` : ''
                      }default() ${ctx.getString(prop.body)}`
                    }
                  }
                }
                const { type, required, skipCheck } = ctx.typeDeclaredProps[key]
                if (!ctx.options.isProd) {
                  return `${key}: { ${concatStrings([
                    `type: ${toRunTimeTypeString(type)}`,
                    `required: ${required}`,
                    skipCheck && 'skipCheck: true',
                    defaultString
                  ])}}`
                } else if (
                  type.some(
                    el =>
                      el === 'Boolean' ||
                      ((!hasStaticDefaults || defaultString) &&
                        el === 'Function')
                  )
                ) {
                  return `${key}: { ${concatStrings([
                    `type: ${toRunTimeTypeString(type)}`,
                    defaultString
                  ])}}`
                } else {
                  //
                  return `${key}: ${
                    defaultString ? `{ ${defaultString} }` : `{}`
                  }`
                }
              })
              .join(',\n ')}\n }`

  if (ctx.propsRuntimeDefaults && !hasStaticDefaults) {
    propsDecls = `${ctx.helper('mergeDefaults')}(${propsDecls}, ${ctx.getString(
      ctx.propsRuntimeDefaults
    )})`
  }
  console.log('genPropsFromTs', propsDecls)
  return propsDecls
}

function hasStaticWithDefaults(ctx: ScriptCompileContext) {
  return (
    ctx.propsRuntimeDefaults &&
    ctx.propsRuntimeDefaults.type === 'ObjectExpression' &&
    ctx.propsRuntimeDefaults.properties.every(
      node =>
        node.type !== 'SpreadElement' &&
        (!node.computed || node.key.type.endsWith('Literal'))
    )
  )
}

// function toRuntimeTypeString(type: string[]) {
// throw new Error('Function not implemented.')
// }
