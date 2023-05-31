import {
  Node,
  LVal,
  Identifier,
  TSTypeLiteral,
  TSInterfaceBody
} from '@babel/types'
import { isCallOf } from '@vue/compiler-dom'
import { ScriptCompileContext } from './context'
import { resolveObjectKey } from './utils'
import { resolveQualifiedType } from './resolveType'

export const DEFINE_PROPS = 'defineProps'
export const WITH_DEFAULTS = 'withDefaults'

export type PropsDeclType = (TSTypeLiteral | TSInterfaceBody) & {
  __fromNormalScript?: boolean | null
}
export function processDefineProps(
  ctx: ScriptCompileContext,
  node: Node,
  declId?: LVal
): boolean {
  if (!isCallOf(node, DEFINE_PROPS)) {
    return false
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

    const propsTypeDeclRaw = node.typeParameters.params[0]
    ctx.propsTypeDecl = resolveQualifiedType(
      ctx,
      propsTypeDeclRaw,
      node => node.type === 'TSTypeLiteral'
    ) as PropsDeclType | undefined

    if (!ctx.propsTypeDecl) {
      ctx.error(
        `type argument passed to ${DEFINE_PROPS}() must be a literal type, ` +
          `or a reference to an interface or literal type.`,
        propsTypeDeclRaw
      )
    }
  }

  if (declId) {
    // handle props destructure
    if (declId.type === 'ObjectPattern') {
      ctx.propsDestructureDecl = declId
      for (const prop of declId.properties) {
        if (prop.type === 'ObjectProperty') {
          const propKey = resolveObjectKey(prop.key, prop.computed)

          if (!propKey) {
            ctx.error(
              `${DEFINE_PROPS}() destructure cannot use computed key.`,
              prop.key
            )
          }

          if (prop.value.type === 'AssignmentPattern') {
            // default value { foo = 123 }
            const { left, right } = prop.value
            if (left.type !== 'Identifier') {
              ctx.error(
                `${DEFINE_PROPS}() destructure does not support nested patterns.`,
                left
              )
            }
            // store default value
            ctx.propsDestructuredBindings[propKey] = {
              local: left.name,
              default: right
            }
          } else if (prop.value.type === 'Identifier') {
            // simple destructure
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
          // rest spread
          ctx.propsDestructureRestId = (prop.argument as Identifier).name
        }
      }
    } else {
      ctx.propsIdentifier = ctx.getString(declId)
    }
  }

  return true
}
