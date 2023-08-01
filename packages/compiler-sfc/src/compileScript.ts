import {
  BindingMetadata,
  BindingTypes,
  createRoot,
  NodeTypes,
  transform,
  parserOptions,
  UNREF,
  SimpleExpressionNode,
  isFunctionType,
  walkIdentifiers,
  getImportedName
} from '@vue/compiler-dom'
import { DEFAULT_FILENAME, SFCDescriptor, SFCScriptBlock } from './parse'
import { parse as _parse, parseExpression, ParserPlugin } from '@babel/parser'
import { camelize, capitalize, generateCodeFrame, makeMap } from '@vue/shared'
import {
  Node,
  Declaration,
  ObjectPattern,
  ObjectExpression,
  ArrayPattern,
  Identifier,
  ExportSpecifier,
  TSTypeLiteral,
  TSFunctionType,
  ArrayExpression,
  Statement,
  CallExpression,
  RestElement,
  TSInterfaceBody
} from '@babel/types'
import { walk } from 'estree-walker'
import { RawSourceMap } from 'source-map'
import { CSS_VARS_HELPER, genCssVarsCode } from './style/cssVars'
import { compileTemplate, SFCTemplateCompileOptions } from './compileTemplate'
import { warnOnce } from './warn'
import { createCache } from './cache'
import { shouldTransform, transformAST } from '@vue/reactivity-transform'
import { transformDestructuredProps } from './script/definePropsDestructure'
import { ScriptCompileContext } from './script/context'
import {
  processDefineProps,
  processWithDefaults,
  DEFINE_PROPS,
  WITH_DEFAULTS,
  genRuntimeProps,
  PropsDestructureBindings
} from './script/defineProps'
import {
  processDefineModel,
  DEFINE_MODEL,
  ModelDecl
} from './script/defineModel'
import { isCallOf, resolveObjectKey, unwrapTSNode } from './script/utils'
// import { inferRuntimeType } from './script/resolveType'
import { processDefineSlots } from './script/defineSlots'
import {
  DEFINE_EMITS,
  EmitsDeclType,
  genRuntimeEmits,
  processDefineEmits
} from './script/defineEmits'
import { DEFINE_EXPOSE, processDefineExpose } from './script/defineExpose'
import { DEFINE_OPTIONS, processDefineOptions } from './script/defineOptions'
import { processAwait } from './script/topLevelAwait'
import {
  normalScriptDefaultVar,
  processNormalScript
} from './script/normalScript'

const isBuiltInDir = makeMap(
  `once,memo,if,for,else,else-if,slot,text,html,on,bind,model,show,cloak,is`
)

export interface SFCScriptCompileOptions {
  /**
   * Scope ID for prefixing injected CSS variables.
   * This must be consistent with the `id` passed to `compileStyle`.
   */
  id: string
  /**
   * Production mode. Used to determine whether to generate hashed CSS variables
   */
  isProd?: boolean
  /**
   * Enable/disable source map. Defaults to true.
   */
  sourceMap?: boolean
  /**
   * https://babeljs.io/docs/en/babel-parser#plugins
   */
  babelParserPlugins?: ParserPlugin[]
  /**
   * (Experimental) Enable syntax transform for using refs without `.value` and
   * using destructured props with reactivity
   * @deprecated the Reactivity Transform proposal has been dropped. This
   * feature will be removed from Vue core in 3.4. If you intend to continue
   * using it, disable this and switch to the [Vue Macros implementation](https://vue-macros.sxzz.moe/features/reactivity-transform.html).
   */
  reactivityTransform?: boolean
  /**
   * Compile the template and inline the resulting render function
   * directly inside setup().
   * - Only affects `<script setup>`
   * - This should only be used in production because it prevents the template
   * from being hot-reloaded separately from component state.
   */
  inlineTemplate?: boolean
  /**
   * Generate the final component as a variable instead of default export.
   * This is useful in e.g. @vitejs/plugin-vue where the script needs to be
   * placed inside the main module.
   */
  genDefaultAs?: string
  /**
   * Options for template compilation when inlining. Note these are options that
   * would normally be passed to `compiler-sfc`'s own `compileTemplate()`, not
   * options passed to `compiler-dom`.
   */
  templateOptions?: Partial<SFCTemplateCompileOptions>
  /**
   * Hoist <script setup> static constants.
   * - Only enables when one `<script setup>` exists.
   * @default true
   */
  hoistStatic?: boolean
  /**
   * (**Experimental**) Enable macro `defineModel`
   */
  defineModel?: boolean
}

export interface ImportBinding {
  isType: boolean
  imported: string
  local: string
  source: string
  isFromSetup: boolean
  isUsedInTemplate: boolean
}

/**
 * Compile `<script setup>`
 * It requires the whole SFC descriptor because we need to handle and merge
 * normal `<script>` + `<script setup>` if both are present.
 */
export function compileScript(
  sfc: SFCDescriptor,
  options: SFCScriptCompileOptions
): SFCScriptBlock {
  // let { script, scriptSetup, source, filename } = sfc
  // // feature flags
  // // TODO remove in 3.4
  // const enableReactivityTransform = !!options.reactivityTransform
  // const isProd = !!options.isProd
  // const genSourceMap = options.sourceMap !== false
  // const hoistStatic = options.hoistStatic !== false && !script
  // let refBindings: string[] | undefined

  if (!options.id) {
    warnOnce(
      `compileScript now requires passing the \`id\` option.\n` +
        `Upgrade your vite or vue-loader version for compatibility with ` +
        `the latest experimental proposals.`
    )
  }
  const ctx = new ScriptCompileContext(sfc, options)
  const { script, scriptSetup, source, filename } = sfc
  const hoistStatic = options.hoistStatic !== false && !script
  const scopeId = options.id ? options.id.replace(/^data-v-/, '') : ''
  const scriptLang = script && script.lang
  const scriptSetupLang = scriptSetup && scriptSetup.lang

  //TODO remove in 3.4
  const enableReactivityTransform = !!options.reactivityTransform
  let refBindings: string[] | undefined

  if (!scriptSetup) {
    if (!script) {
      throw new Error(`[@vue/compiler-sfc] SFC contains no <script> tags.`)
    }
    // normal <script> only
    return processNormalScript(ctx, scopeId)
  }

  if (script && scriptLang !== scriptSetupLang) {
    throw new Error(
      `[@vue/compiler-sfc] <script> and <script setup> must have the same ` +
        `language type.`
    )
  }

  if (scriptSetupLang && !ctx.isJS && !ctx.isTS) {
    // do not process non js/ts script blocks
    return scriptSetup
  }

  // metadata that needs to be returned
  // const ctx.bindingMetadata: ctx.bindingMetadata = {}
  const helperImports: Set<string> = new Set()
  const scriptBindings: Record<string, BindingTypes> = Object.create(null)
  const setupBindings: Record<string, BindingTypes> = Object.create(null)

  let defaultExport: Node | undefined
  let emitsRuntimeDecl: Node | undefined
  let emitsTypeDecl: EmitsDeclType | undefined
  let emitIdentifier: string | undefined
  let optionsRuntimeDecl: Node | undefined
  let modelDecls: Record<string, ModelDecl> = {}
  let hasAwait = false
  let hasInlinedSsrRenderFn = false

  const typeDeclaredEmits: Set<string> = new Set()
  // props destructure data
  const propsDestructuredBindings: PropsDestructureBindings =
    Object.create(null)

  // magic-string state
  // const s = new MagicString(source)
  const startOffset = scriptSetup.loc.start.offset
  const endOffset = scriptSetup.loc.end.offset
  const scriptStartOffset = script && script.loc.start.offset
  const scriptEndOffset = script && script.loc.end.offset

  function helper(key: string): string {
    helperImports.add(key)
    return `_${key}`
  }

  function error(
    msg: string,
    node: Node,
    end: number = node.end! + startOffset
  ): never {
    throw new Error(
      `[@vue/compiler-sfc] ${msg}\n\n${sfc.filename}\n${generateCodeFrame(
        source,
        node.start! + startOffset,
        end
      )}`
    )
  }

  function hoistNode(node: Statement) {
    const start = node.start! + startOffset
    let end = node.end! + startOffset
    // locate comment
    if (node.trailingComments && node.trailingComments.length > 0) {
      const lastCommentNode =
        node.trailingComments[node.trailingComments.length - 1]
      end = lastCommentNode.end! + startOffset
    }
    // locate the end of whitespace between this statement and the next
    while (end <= source.length) {
      if (!/\s/.test(source.charAt(end))) {
        break
      }
      end++
    }
    ctx.s.move(start, end, 0)
  }

  function registerUserImport(
    source: string,
    local: string,
    imported: string,
    isType: boolean,
    isFromSetup: boolean,
    needTemplateUsageCheck: boolean
  ) {
    // template usage check is only needed in non-inline mode, so we can skip
    // the work if inlineTemplate is true.
    let isUsedInTemplate = needTemplateUsageCheck
    if (
      needTemplateUsageCheck &&
      ctx.isTS &&
      sfc.template &&
      !sfc.template.src &&
      !sfc.template.lang
    ) {
      isUsedInTemplate = isImportUsed(local, sfc)
    }

    ctx.userImports[local] = {
      isType,
      imported,
      local,
      source,
      isFromSetup,
      isUsedInTemplate
    }
  }

  function checkInvalidScopeReference(node: Node | undefined, method: string) {
    if (!node) return
    walkIdentifiers(node, id => {
      const binding = setupBindings[id.name]
      if (binding && binding !== BindingTypes.LITERAL_CONST) {
        error(
          `\`${method}()\` in <script setup> cannot reference locally ` +
            `declared variables because it will be hoisted outside of the ` +
            `setup() function. If your component options require initialization ` +
            `in the module scope, use a separate normal <script> to export ` +
            `the options instead.`,
          id
        )
      }
    })
  }

  // 0. parse both <script> and <script setup> blocks
  const scriptAst = script && ctx.scriptAST!

  const scriptSetupAst = ctx.scriptSetupAST!
  // 1.1 walk import delcarations of <script>
  if (scriptAst) {
    for (const node of scriptAst.body) {
      if (node.type === 'ImportDeclaration') {
        // record imports for dedupe
        for (const specifier of node.specifiers) {
          const imported = getImportedName(specifier)
          registerUserImport(
            node.source.value,
            specifier.local.name,
            imported,
            node.importKind === 'type' ||
              (specifier.type === 'ImportSpecifier' &&
                specifier.importKind === 'type'),
            false,
            !options.inlineTemplate
          )
        }
      }
    }
  }

  // 1.2 walk import declarations of <script setup>
  for (const node of scriptSetupAst.body) {
    if (node.type === 'ImportDeclaration') {
      // import declarations are moved to top
      hoistNode(node)

      // dedupe imports
      let removed = 0
      const removeSpecifier = (i: number) => {
        const removeLeft = i > removed
        removed++
        const current = node.specifiers[i]
        const next = node.specifiers[i + 1]
        ctx.s.remove(
          removeLeft
            ? node.specifiers[i - 1].end! + startOffset
            : current.start! + startOffset,
          next && !removeLeft
            ? next.start! + startOffset
            : current.end! + startOffset
        )
      }

      for (let i = 0; i < node.specifiers.length; i++) {
        const specifier = node.specifiers[i]
        const local = specifier.local.name
        const imported = getImportedName(specifier)
        const source = node.source.value
        const existing = ctx.userImports[local]
        if (
          source === 'vue' &&
          (imported === DEFINE_PROPS ||
            imported === DEFINE_EMITS ||
            imported === DEFINE_EXPOSE)
        ) {
          warnOnce(
            `\`${imported}\` is a compiler macro and no longer needs to be imported.`
          )
          removeSpecifier(i)
        } else if (existing) {
          if (existing.source === source && existing.imported === imported) {
            // already imported in <script setup>, dedupe
            removeSpecifier(i)
          } else {
            error(`different imports aliased to same local name.`, specifier)
          }
        } else {
          registerUserImport(
            source,
            local,
            imported,
            node.importKind === 'type' ||
              (specifier.type === 'ImportSpecifier' &&
                specifier.importKind === 'type'),
            true,
            !options.inlineTemplate
          )
        }
      }
      if (node.specifiers.length && removed === node.specifiers.length) {
        ctx.s.remove(node.start! + startOffset, node.end! + startOffset)
      }
    }
  }

  // 1.3 resolve possible user import alias of `ref` and `reactive`
  const vueImportAliases: Record<string, string> = {}
  for (const key in ctx.userImports) {
    const { source, imported, local } = ctx.userImports[key]
    if (source === 'vue') vueImportAliases[imported] = local
  }

  // 2.1 process normal <script> body
  if (script && scriptAst) {
    for (const node of scriptAst.body) {
      if (node.type === 'ExportDefaultDeclaration') {
        // export default
        defaultExport = node

        // check if user has manually specified `name` or 'render` option in
        // export default
        // if has name, skip name inference
        // if has render and no template, generate return object instead of
        // empty render function (#4980)
        let optionProperties
        if (defaultExport.declaration.type === 'ObjectExpression') {
          optionProperties = defaultExport.declaration.properties
        } else if (
          defaultExport.declaration.type === 'CallExpression' &&
          defaultExport.declaration.arguments[0] &&
          defaultExport.declaration.arguments[0].type === 'ObjectExpression'
        ) {
          optionProperties = defaultExport.declaration.arguments[0].properties
        }
        if (optionProperties) {
          for (const s of optionProperties) {
            if (
              s.type === 'ObjectProperty' &&
              s.key.type === 'Identifier' &&
              s.key.name === 'name'
            ) {
              ctx.hasDefaultExportName = true
            }
            if (
              (s.type === 'ObjectMethod' || s.type === 'ObjectProperty') &&
              s.key.type === 'Identifier' &&
              s.key.name === 'render'
            ) {
              // TODO warn when we provide a better way to do it?
              ctx.hasDefaultExportRender = true
            }
          }
        }

        // export default { ... } --> const __default__ = { ... }
        const start = node.start! + scriptStartOffset!
        const end = node.declaration.start! + scriptStartOffset!
        ctx.s.overwrite(start, end, `const ${normalScriptDefaultVar} = `)
      } else if (node.type === 'ExportNamedDeclaration') {
        const defaultSpecifier = node.specifiers.find(
          s => s.exported.type === 'Identifier' && s.exported.name === 'default'
        ) as ExportSpecifier
        if (defaultSpecifier) {
          defaultExport = node
          // 1. remove specifier
          if (node.specifiers.length > 1) {
            ctx.s.remove(
              defaultSpecifier.start! + scriptStartOffset!,
              defaultSpecifier.end! + scriptStartOffset!
            )
          } else {
            ctx.s.remove(
              node.start! + scriptStartOffset!,
              node.end! + scriptStartOffset!
            )
          }
          if (node.source) {
            // export { x as default } from './x'
            // rewrite to `import { x as __default__ } from './x'` and
            // add to top
            ctx.s.prepend(
              `import { ${defaultSpecifier.local.name} as ${normalScriptDefaultVar} } from '${node.source.value}'\n`
            )
          } else {
            // export { x as default }
            // rewrite to `const __default__ = x` and move to end
            ctx.s.appendLeft(
              scriptEndOffset!,
              `\nconst ${normalScriptDefaultVar} = ${defaultSpecifier.local.name}\n`
            )
          }
        }
        if (node.declaration) {
          walkDeclaration(
            'script',
            node.declaration,
            scriptBindings,
            vueImportAliases,
            hoistStatic
          )
        }
      } else if (
        (node.type === 'VariableDeclaration' ||
          node.type === 'FunctionDeclaration' ||
          node.type === 'ClassDeclaration' ||
          node.type === 'TSEnumDeclaration') &&
        !node.declare
      ) {
        walkDeclaration(
          'script',
          node,
          scriptBindings,
          vueImportAliases,
          hoistStatic
        )
      }
    }

    // apply reactivity transform
    // TODO remove in 3.4
    if (enableReactivityTransform && shouldTransform(script.content)) {
      const { rootRefs, importedHelpers } = transformAST(
        scriptAst,
        ctx.s,
        scriptStartOffset!
      )
      refBindings = rootRefs
      for (const h of importedHelpers) {
        helperImports.add(h)
      }
    }

    // <script> after <script setup>
    // we need to move the block up so that `const __default__` is
    // declared before being used in the actual component definition
    if (scriptStartOffset! > startOffset) {
      // if content doesn't end with newline, add one
      if (!/\n$/.test(script.content.trim())) {
        ctx.s.appendLeft(scriptEndOffset!, `\n`)
      }
      ctx.s.move(scriptStartOffset!, scriptEndOffset!, 0)
    }
  }

  // 2.2 process <script setup> body
  for (const node of scriptSetupAst.body) {
    // (Dropped) `ref: x` bindings
    // TODO remove when out of experimental
    if (
      node.type === 'LabeledStatement' &&
      node.label.name === 'ref' &&
      node.body.type === 'ExpressionStatement'
    ) {
      error(
        `ref sugar using the label syntax was an experimental proposal and ` +
          `has been dropped based on community feedback. Please check out ` +
          `the new proposal at https://github.com/vuejs/rfcs/discussions/369`,
        node
      )
    }

    if (node.type === 'ExpressionStatement') {
      const expr = unwrapTSNode(node.expression)
      // process `defineProps` and `defineEmit(s)` calls
      if (
        processDefineProps(ctx, expr) ||
        processDefineEmits(ctx, expr) ||
        processDefineOptions(ctx, expr) ||
        processWithDefaults(ctx, expr) ||
        processDefineSlots(ctx, expr)
      ) {
        ctx.s.remove(node.start! + startOffset, node.end! + startOffset)
      } else if (processDefineExpose(ctx, expr)) {
        // defineExpose({}) -> expose({})
        const callee = (expr as CallExpression).callee
        ctx.s.overwrite(
          callee.start! + startOffset,
          callee.end! + startOffset,
          '__expose'
        )
      } else {
        processDefineModel(ctx, expr)
      }
    }

    if (node.type === 'VariableDeclaration' && !node.declare) {
      const total = node.declarations.length
      let left = total
      let lastNonRemoved: number | undefined

      for (let i = 0; i < total; i++) {
        const decl = node.declarations[i]
        const init = decl.init && unwrapTSNode(decl.init)
        if (init) {
          if (processDefineOptions(ctx, init)) {
            error(
              `${DEFINE_OPTIONS}() has no returning value, it cannot be assigned.`,
              node
            )
          }

          // defineProps / defineEmits
          const isDefineProps =
            processDefineProps(ctx, init, decl.id) ||
            processWithDefaults(ctx, init, decl.id)
          const isDefineEmits =
            !isDefineProps && processDefineEmits(ctx, init, decl.id)
          !isDefineEmits &&
            (processDefineSlots(ctx, init, decl.id) ||
              processDefineModel(ctx, init, decl.id))

          if (isDefineProps || isDefineEmits) {
            if (left === 1) {
              ctx.s.remove(node.start! + startOffset, node.end! + startOffset)
            } else {
              let start = decl.start! + startOffset
              let end = decl.end! + startOffset
              if (i === total - 1) {
                // last one, locate the end of the last one that is not removed
                // if we arrive at this branch, there must have been a
                // non-removed decl before us, so lastNonRemoved is non-null.
                start = node.declarations[lastNonRemoved!].end! + startOffset
              } else {
                // not the last one, locate the start of the next
                end = node.declarations[i + 1].start! + startOffset
              }
              ctx.s.remove(start, end)
              left--
            }
          } else {
            lastNonRemoved = i
          }
        }
      }
    }

    let isAllLiteral = false
    // walk declarations to record declared bindings
    if (
      (node.type === 'VariableDeclaration' ||
        node.type === 'FunctionDeclaration' ||
        node.type === 'ClassDeclaration' ||
        node.type === 'TSEnumDeclaration') &&
      !node.declare
    ) {
      isAllLiteral = walkDeclaration(
        'scriptSetup',
        node,
        setupBindings,
        vueImportAliases,
        hoistStatic
      )
    }

    // hoist literal constants
    if (hoistStatic && isAllLiteral) {
      hoistNode(node)
    }

    // walk statements & named exports / variable declarations for top level
    // await
    if (
      (node.type === 'VariableDeclaration' && !node.declare) ||
      node.type.endsWith('Statement')
    ) {
      const scope: Statement[][] = [scriptSetupAst.body]
      ;(walk as any)(node, {
        enter(child: Node, parent: Node) {
          if (isFunctionType(child)) {
            this.skip()
          }
          if (child.type === 'BlockStatement') {
            scope.push(child.body)
          }
          if (child.type === 'AwaitExpression') {
            hasAwait = true
            // if the await expression is an expression statement and
            // - is in the root scope
            // - or is not the first statement in a nested block scope
            // then it needs a semicolon before the generated code.
            const currentScope = scope[scope.length - 1]
            const needsSemi = currentScope.some((n, i) => {
              return (
                (scope.length === 1 || i > 0) &&
                n.type === 'ExpressionStatement' &&
                n.start === child.start
              )
            })
            processAwait(
              ctx,
              child,
              needsSemi,
              parent.type === 'ExpressionStatement'
            )
          }
        },
        exit(node: Node) {
          if (node.type === 'BlockStatement') scope.pop()
        }
      })
    }

    if (
      (node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type') ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportDefaultDeclaration'
    ) {
      error(
        `<script setup> cannot contain ES module exports. ` +
          `If you are using a previous version of <script setup>, please ` +
          `consult the updated RFC at https://github.com/vuejs/rfcs/pull/227.`,
        node
      )
    }

    if (ctx.isTS) {
      // move all Type declarations to outer scope
      if (
        node.type.startsWith('TS') ||
        (node.type === 'ExportNamedDeclaration' &&
          node.exportKind === 'type') ||
        (node.type === 'VariableDeclaration' && node.declare)
      ) {
        if (node.type !== 'TSEnumDeclaration') {
          hoistNode(node)
        }
      }
    }
  }

  // 3.1 props destructure transform
  if (ctx.propsDestructureDecl) {
    transformDestructuredProps(ctx, vueImportAliases)
  }

  // 3.2 Apply reactivity transform
  // TODO remove in 3.4
  if (
    enableReactivityTransform &&
    // normal <script> had ref bindings that maybe used in <script setup>
    (refBindings || shouldTransform(scriptSetup.content))
  ) {
    const { rootRefs, importedHelpers } = transformAST(
      scriptSetupAst,
      ctx.s,
      startOffset,
      refBindings
    )
    refBindings = refBindings ? [...refBindings, ...rootRefs] : rootRefs
    for (const h of importedHelpers) {
      helperImports.add(h)
    }
  }

  // 4. extract runtime props/emits code from setup context type

  // extractRuntimeProps(ctx)

  if (emitsTypeDecl) {
    extractRuntimeEmits(emitsTypeDecl, typeDeclaredEmits, error)
  }

  // 5. check macro args to make sure it doesn't reference setup scope
  // variables
  checkInvalidScopeReference(ctx.propsRuntimeDecl, DEFINE_PROPS)
  checkInvalidScopeReference(ctx.propsRuntimeDefaults, DEFINE_PROPS)
  checkInvalidScopeReference(ctx.propsDestructureDecl, DEFINE_PROPS)
  checkInvalidScopeReference(emitsRuntimeDecl, DEFINE_EMITS)
  checkInvalidScopeReference(optionsRuntimeDecl, DEFINE_OPTIONS)

  // 6. remove non-script content
  if (script) {
    if (startOffset < scriptStartOffset!) {
      // <script setup> before <script>
      ctx.s.remove(0, startOffset)
      ctx.s.remove(endOffset, scriptStartOffset!)
      ctx.s.remove(scriptEndOffset!, source.length)
    } else {
      // <script> before <script setup>
      ctx.s.remove(0, scriptStartOffset!)
      ctx.s.remove(scriptEndOffset!, startOffset)
      ctx.s.remove(endOffset, source.length)
    }
  } else {
    // only <script setup>
    ctx.s.remove(0, startOffset)
    ctx.s.remove(endOffset, source.length)
  }

  // 7. analyze binding metadata
  if (scriptAst) {
    Object.assign(ctx.bindingMetadata, analyzeScriptBindings(scriptAst.body))
  }
  if (ctx.propsRuntimeDecl) {
    for (const key of getObjectOrArrayExpressionKeys(ctx.propsRuntimeDecl)) {
      ctx.bindingMetadata[key] = BindingTypes.PROPS
    }
  }

  for (const key in modelDecls) {
    ctx.bindingMetadata[key] = BindingTypes.PROPS
  }
  // props aliases
  if (ctx.propsDestructureDecl) {
    if (ctx.propsDestructureRestId) {
      ctx.bindingMetadata[ctx.propsDestructureRestId] =
        BindingTypes.SETUP_REACTIVE_CONST
    }
    for (const key in propsDestructuredBindings) {
      const { local } = propsDestructuredBindings[key]
      if (local !== key) {
        ctx.bindingMetadata[local] = BindingTypes.PROPS_ALIASED
        ;(ctx.bindingMetadata.__propsAliases ||
          (ctx.bindingMetadata.__propsAliases = {}))[local] = key
      }
    }
  }
  for (const [key, { isType, imported, source }] of Object.entries(
    ctx.userImports
  )) {
    if (isType) continue
    ctx.bindingMetadata[key] =
      imported === '*' ||
      (imported === 'default' && source.endsWith('.vue')) ||
      source === 'vue'
        ? BindingTypes.SETUP_CONST
        : BindingTypes.SETUP_MAYBE_REF
  }
  for (const key in scriptBindings) {
    ctx.bindingMetadata[key] = scriptBindings[key]
  }
  for (const key in setupBindings) {
    ctx.bindingMetadata[key] = setupBindings[key]
  }
  // known ref bindings
  if (refBindings) {
    for (const key of refBindings) {
      ctx.bindingMetadata[key] = BindingTypes.SETUP_REF
    }
  }

  // 8. inject `useCssVars` calls
  if (
    sfc.cssVars.length &&
    // no need to do this when targeting SSR
    !(options.inlineTemplate && options.templateOptions?.ssr)
  ) {
    helperImports.add(CSS_VARS_HELPER)
    helperImports.add('unref')
    ctx.s.prependLeft(
      startOffset,
      `\n${genCssVarsCode(
        sfc.cssVars,
        ctx.bindingMetadata,
        scopeId,
        !!options.isProd
      )}\n`
    )
  }

  // 9. finalize setup() argument signature
  let args = `__props`
  if (ctx.propsTypeDecl) {
    // mark as any and only cast on assignment
    // since the user defined complex types may be incompatible with the
    // inferred type from generated runtime declarations
    args += `: any`
  }
  // inject user assignment of props
  // we use a default __props so that template expressions referencing props
  // can use it directly
  if (ctx.propsIdentifier) {
    ctx.s.prependLeft(
      startOffset,
      `\nconst ${ctx.propsIdentifier} = __props;\n`
    )
  }
  if (ctx.propsDestructureRestId) {
    ctx.s.prependLeft(
      startOffset,
      `\nconst ${ctx.propsDestructureRestId} = ${helper(
        `createPropsRestProxy`
      )}(__props, ${JSON.stringify(Object.keys(propsDestructuredBindings))});\n`
    )
  }
  // inject temp variables for async context preservation
  if (hasAwait) {
    const any = ctx.isTS ? `: any` : ``
    ctx.s.prependLeft(startOffset, `\nlet __temp${any}, __restore${any}\n`)
  }

  const destructureElements =
    ctx.hasDefineExposeCall || !options.inlineTemplate
      ? [`expose: __expose`]
      : []
  if (emitIdentifier) {
    destructureElements.push(
      emitIdentifier === `emit` ? `emit` : `emit: ${emitIdentifier}`
    )
  }
  if (destructureElements.length) {
    args += `, { ${destructureElements.join(', ')} }`
  }

  // 10. generate return statement
  let returned
  if (
    !options.inlineTemplate ||
    (!sfc.template && ctx.hasDefaultExportRender)
  ) {
    // non-inline mode, or has manual render in normal <script>
    // return bindings from script and script setup
    const allBindings: Record<string, any> = {
      ...scriptBindings,
      ...setupBindings
    }
    for (const key in ctx.userImports) {
      if (
        !ctx.userImports[key].isType &&
        ctx.userImports[key].isUsedInTemplate
      ) {
        allBindings[key] = true
      }
    }
    returned = `{ `
    for (const key in allBindings) {
      if (
        allBindings[key] === true &&
        ctx.userImports[key].source !== 'vue' &&
        !ctx.userImports[key].source.endsWith('.vue')
      ) {
        // generate getter for import bindings
        // skip vue imports since we know they will never change
        returned += `get ${key}() { return ${key} }, `
      } else if (ctx.bindingMetadata[key] === BindingTypes.SETUP_LET) {
        // local let binding, also add setter
        const setArg = key === 'v' ? `_v` : `v`
        returned +=
          `get ${key}() { return ${key} }, ` +
          `set ${key}(${setArg}) { ${key} = ${setArg} }, `
      } else {
        returned += `${key}, `
      }
    }
    returned = returned.replace(/, $/, '') + ` }`
  } else {
    // inline mode
    if (sfc.template && !sfc.template.src) {
      if (options.templateOptions && options.templateOptions.ssr) {
        hasInlinedSsrRenderFn = true
      }
      // inline render function mode - we are going to compile the template and
      // inline it right here
      const { code, ast, preamble, tips, errors } = compileTemplate({
        filename,
        source: sfc.template.content,
        inMap: sfc.template.map,
        ...options.templateOptions,
        id: scopeId,
        scoped: sfc.styles.some(s => s.scoped),
        isProd: options.isProd,
        ssrCssVars: sfc.cssVars,
        compilerOptions: {
          ...(options.templateOptions &&
            options.templateOptions.compilerOptions),
          inline: true,
          isTS: ctx.isTS,
          bindingMetadata: ctx.bindingMetadata
        }
      })
      if (tips.length) {
        tips.forEach(warnOnce)
      }
      const err = errors[0]
      if (typeof err === 'string') {
        throw new Error(err)
      } else if (err) {
        if (err.loc) {
          err.message +=
            `\n\n` +
            sfc.filename +
            '\n' +
            generateCodeFrame(
              source,
              err.loc.start.offset,
              err.loc.end.offset
            ) +
            `\n`
        }
        throw err
      }
      if (preamble) {
        ctx.s.prepend(preamble)
      }
      // avoid duplicated unref import
      // as this may get injected by the render function preamble OR the
      // css vars codegen
      if (ast && ast.helpers.has(UNREF)) {
        helperImports.delete('unref')
      }
      returned = code
    } else {
      returned = `() => {}`
    }
  }

  if (!options.inlineTemplate && !__TEST__) {
    // in non-inline mode, the `__isScriptSetup: true` flag is used by
    // componentPublicInstance proxy to allow properties that start with $ or _
    ctx.s.appendRight(
      endOffset,
      `\nconst __returned__ = ${returned}\n` +
        `Object.defineProperty(__returned__, '__isScriptSetup', { enumerable: false, value: true })\n` +
        `return __returned__` +
        `\n}\n\n`
    )
  } else {
    ctx.s.appendRight(endOffset, `\nreturn ${returned}\n}\n\n`)
  }

  // 11. finalize default export
  const genDefaultAs = options.genDefaultAs
    ? `const ${options.genDefaultAs} =`
    : `export default`
  let runtimeOptions = ``
  if (!ctx.hasDefaultExportName && filename && filename !== DEFAULT_FILENAME) {
    const match = filename.match(/([^/\\]+)\.\w+$/)
    if (match) {
      runtimeOptions += `\n  __name: '${match[1]}',`
    }
  }
  if (hasInlinedSsrRenderFn) {
    runtimeOptions += `\n  __ssrInlineRender: true,`
  }

  const propsDecl = genRuntimeProps(ctx)
  if (propsDecl) runtimeOptions += `\n  props: ${propsDecl},`

  const emitsDecl = genRuntimeEmits(ctx)
  if (emitsDecl) runtimeOptions += `\n  emits: ${emitsDecl},`

  let definedOptions = ''
  if (optionsRuntimeDecl) {
    definedOptions = scriptSetup.content
      .slice(optionsRuntimeDecl.start!, optionsRuntimeDecl.end!)
      .trim()
  }

  // <script setup> components are closed by default. If the user did not
  // explicitly call `defineExpose`, call expose() with no args.
  const exposeCall =
    ctx.hasDefineExposeCall || options.inlineTemplate ? `` : `  __expose();\n`
  // wrap setup code with function.
  if (ctx.isTS) {
    // for TS, make sure the exported type is still valid type with
    // correct props information
    // we have to use object spread for types to be merged properly
    // user's TS setting should compile it down to proper targets
    // export default defineComponent({ ...__default__, ... })
    const def =
      (defaultExport ? `\n  ...${normalScriptDefaultVar},` : ``) +
      (definedOptions ? `\n  ...${definedOptions},` : '')
    ctx.s.prependLeft(
      startOffset,
      `\n${genDefaultAs} /*#__PURE__*/${helper(
        `defineComponent`
      )}({${def}${runtimeOptions}\n  ${
        hasAwait ? `async ` : ``
      }setup(${args}) {\n${exposeCall}`
    )
    ctx.s.appendRight(endOffset, `})`)
  } else {
    if (defaultExport || definedOptions) {
      // without TS, can't rely on rest spread, so we use Object.assign
      // export default Object.assign(__default__, { ... })
      ctx.s.prependLeft(
        startOffset,
        `\n${genDefaultAs} /*#__PURE__*/Object.assign(${
          defaultExport ? `${normalScriptDefaultVar}, ` : ''
        }${definedOptions ? `${definedOptions}, ` : ''}{${runtimeOptions}\n  ` +
          `${hasAwait ? `async ` : ``}setup(${args}) {\n${exposeCall}`
      )
      ctx.s.appendRight(endOffset, `})`)
    } else {
      ctx.s.prependLeft(
        startOffset,
        `\n${genDefaultAs} {${runtimeOptions}\n  ` +
          `${hasAwait ? `async ` : ``}setup(${args}) {\n${exposeCall}`
      )
      ctx.s.appendRight(endOffset, `}`)
    }
  }

  // 12. finalize Vue helper imports
  if (helperImports.size > 0) {
    ctx.s.prepend(
      `import { ${[...helperImports]
        .map(h => `${h} as _${h}`)
        .join(', ')} } from 'vue'\n`
    )
  }

  ctx.s.trim()

  return {
    ...scriptSetup,
    bindings: ctx.bindingMetadata,
    imports: ctx.userImports,
    content: ctx.s.toString(),
    map:
      options.sourceMap !== false
        ? (ctx.s.generateMap({
            source: filename,
            hires: true,
            includeContent: true
          }) as unknown as RawSourceMap)
        : undefined,
    scriptAst: scriptAst?.body,
    scriptSetupAst: scriptSetupAst?.body
  }
}

function registerBinding(
  bindings: Record<string, BindingTypes>,
  node: Identifier,
  type: BindingTypes
) {
  bindings[node.name] = type
}

function walkDeclaration(
  from: 'script' | 'scriptSetup',
  node: Declaration,
  bindings: Record<string, BindingTypes>,
  userImportAliases: Record<string, string>,
  hoistStatic: boolean
): boolean {
  let isAllLiteral = false

  if (node.type === 'VariableDeclaration') {
    const isConst = node.kind === 'const'
    isAllLiteral =
      isConst &&
      node.declarations.every(
        decl => decl.id.type === 'Identifier' && isStaticNode(decl.init!)
      )

    // export const foo = ...
    for (const { id, init: _init } of node.declarations) {
      const init = _init && unwrapTSNode(_init)
      const isDefineCall = !!(
        isConst &&
        isCallOf(
          init,
          c => c === DEFINE_PROPS || c === DEFINE_EMITS || c === WITH_DEFAULTS
        )
      )
      if (id.type === 'Identifier') {
        let bindingType
        const userReactiveBinding = userImportAliases['reactive']
        if (
          (hoistStatic || from === 'script') &&
          (isAllLiteral || (isConst && isStaticNode(init!)))
        ) {
          bindingType = BindingTypes.LITERAL_CONST
        } else if (isCallOf(init, userReactiveBinding)) {
          // treat reactive() calls as let since it's meant to be mutable
          bindingType = isConst
            ? BindingTypes.SETUP_REACTIVE_CONST
            : BindingTypes.SETUP_LET
        } else if (
          // if a declaration is a const literal, we can mark it so that
          // the generated render fn code doesn't need to unref() it
          isDefineCall ||
          (isConst && canNeverBeRef(init!, userReactiveBinding))
        ) {
          bindingType = isCallOf(init, DEFINE_PROPS)
            ? BindingTypes.SETUP_REACTIVE_CONST
            : BindingTypes.SETUP_CONST
        } else if (isConst) {
          if (
            isCallOf(init, userImportAliases['ref']) ||
            isCallOf(init, DEFINE_MODEL)
          ) {
            bindingType = BindingTypes.SETUP_REF
          } else {
            bindingType = BindingTypes.SETUP_MAYBE_REF
          }
        } else {
          bindingType = BindingTypes.SETUP_LET
        }
        registerBinding(bindings, id, bindingType)
      } else {
        if (isCallOf(init, DEFINE_PROPS)) {
          continue
        }
        if (id.type === 'ObjectPattern') {
          walkObjectPattern(id, bindings, isConst, isDefineCall)
        } else if (id.type === 'ArrayPattern') {
          walkArrayPattern(id, bindings, isConst, isDefineCall)
        }
      }
    }
  } else if (node.type === 'TSEnumDeclaration') {
    isAllLiteral = node.members.every(
      member => !member.initializer || isStaticNode(member.initializer)
    )
    bindings[node.id!.name] = isAllLiteral
      ? BindingTypes.LITERAL_CONST
      : BindingTypes.SETUP_CONST
  } else if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'ClassDeclaration'
  ) {
    // export function foo() {} / export class Foo {}
    // export declarations must be named.
    bindings[node.id!.name] = BindingTypes.SETUP_CONST
  }

  return isAllLiteral
}

function walkObjectPattern(
  node: ObjectPattern,
  bindings: Record<string, BindingTypes>,
  isConst: boolean,
  isDefineCall = false
) {
  for (const p of node.properties) {
    if (p.type === 'ObjectProperty') {
      if (p.key.type === 'Identifier' && p.key === p.value) {
        // shorthand: const { x } = ...
        const type = isDefineCall
          ? BindingTypes.SETUP_CONST
          : isConst
          ? BindingTypes.SETUP_MAYBE_REF
          : BindingTypes.SETUP_LET
        registerBinding(bindings, p.key, type)
      } else {
        walkPattern(p.value, bindings, isConst, isDefineCall)
      }
    } else {
      // ...rest
      // argument can only be identifier when destructuring
      const type = isConst ? BindingTypes.SETUP_CONST : BindingTypes.SETUP_LET
      registerBinding(bindings, p.argument as Identifier, type)
    }
  }
}

function walkArrayPattern(
  node: ArrayPattern,
  bindings: Record<string, BindingTypes>,
  isConst: boolean,
  isDefineCall = false
) {
  for (const e of node.elements) {
    e && walkPattern(e, bindings, isConst, isDefineCall)
  }
}

function walkPattern(
  node: Node,
  bindings: Record<string, BindingTypes>,
  isConst: boolean,
  isDefineCall = false
) {
  if (node.type === 'Identifier') {
    const type = isDefineCall
      ? BindingTypes.SETUP_CONST
      : isConst
      ? BindingTypes.SETUP_MAYBE_REF
      : BindingTypes.SETUP_LET
    registerBinding(bindings, node, type)
  } else if (node.type === 'RestElement') {
    // argument can only be identifier when destructuring
    const type = isConst ? BindingTypes.SETUP_CONST : BindingTypes.SETUP_LET
    registerBinding(bindings, node.argument as Identifier, type)
  } else if (node.type === 'ObjectPattern') {
    walkObjectPattern(node, bindings, isConst)
  } else if (node.type === 'ArrayPattern') {
    walkArrayPattern(node, bindings, isConst)
  } else if (node.type === 'AssignmentPattern') {
    if (node.left.type === 'Identifier') {
      const type = isDefineCall
        ? BindingTypes.SETUP_CONST
        : isConst
        ? BindingTypes.SETUP_MAYBE_REF
        : BindingTypes.SETUP_LET
      registerBinding(bindings, node.left, type)
    } else {
      walkPattern(node.left, bindings, isConst)
    }
  }
}

function extractRuntimeEmits(
  node: TSFunctionType | TSTypeLiteral | TSInterfaceBody,
  emits: Set<string>,
  error: (msg: string, node: Node) => never
) {
  if (node.type === 'TSTypeLiteral' || node.type === 'TSInterfaceBody') {
    const members = node.type === 'TSTypeLiteral' ? node.members : node.body
    let hasCallSignature = false
    let hasProperty = false
    for (let t of members) {
      if (t.type === 'TSCallSignatureDeclaration') {
        extractEventNames(t.parameters[0], emits)
        hasCallSignature = true
      }
      if (t.type === 'TSPropertySignature') {
        if (t.key.type === 'Identifier' && !t.computed) {
          emits.add(t.key.name)
          hasProperty = true
        } else if (t.key.type === 'StringLiteral' && !t.computed) {
          emits.add(t.key.value)
          hasProperty = true
        } else {
          error(`defineEmits() type cannot use computed keys.`, t.key)
        }
      }
    }
    if (hasCallSignature && hasProperty) {
      error(
        `defineEmits() type cannot mixed call signature and property syntax.`,
        node
      )
    }
    return
  } else {
    extractEventNames(node.parameters[0], emits)
  }
}

function extractEventNames(
  eventName: Identifier | RestElement,
  emits: Set<string>
) {
  if (
    eventName.type === 'Identifier' &&
    eventName.typeAnnotation &&
    eventName.typeAnnotation.type === 'TSTypeAnnotation'
  ) {
    const typeNode = eventName.typeAnnotation.typeAnnotation
    if (typeNode.type === 'TSLiteralType') {
      if (
        typeNode.literal.type !== 'UnaryExpression' &&
        typeNode.literal.type !== 'TemplateLiteral'
      ) {
        emits.add(String(typeNode.literal.value))
      }
    } else if (typeNode.type === 'TSUnionType') {
      for (const t of typeNode.types) {
        if (
          t.type === 'TSLiteralType' &&
          t.literal.type !== 'UnaryExpression' &&
          t.literal.type !== 'TemplateLiteral'
        ) {
          emits.add(String(t.literal.value))
        }
      }
    }
  }
}

function canNeverBeRef(node: Node, userReactiveImport?: string): boolean {
  if (isCallOf(node, userReactiveImport)) {
    return true
  }
  switch (node.type) {
    case 'UnaryExpression':
    case 'BinaryExpression':
    case 'ArrayExpression':
    case 'ObjectExpression':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'UpdateExpression':
    case 'ClassExpression':
    case 'TaggedTemplateExpression':
      return true
    case 'SequenceExpression':
      return canNeverBeRef(
        node.expressions[node.expressions.length - 1],
        userReactiveImport
      )
    default:
      if (isLiteralNode(node)) {
        return true
      }
      return false
  }
}

function isStaticNode(node: Node): boolean {
  switch (node.type) {
    case 'UnaryExpression': // void 0, !true
      return isStaticNode(node.argument)

    case 'LogicalExpression': // 1 > 2
    case 'BinaryExpression': // 1 + 2
      return isStaticNode(node.left) && isStaticNode(node.right)

    case 'ConditionalExpression': {
      // 1 ? 2 : 3
      return (
        isStaticNode(node.test) &&
        isStaticNode(node.consequent) &&
        isStaticNode(node.alternate)
      )
    }

    case 'SequenceExpression': // (1, 2)
    case 'TemplateLiteral': // `foo${1}`
      return node.expressions.every(expr => isStaticNode(expr))

    case 'ParenthesizedExpression': // (1)
    case 'TSNonNullExpression': // 1!
    case 'TSAsExpression': // 1 as number
    case 'TSTypeAssertion': // (<number>2)
      return isStaticNode(node.expression)

    default:
      if (isLiteralNode(node)) {
        return true
      }
      return false
  }
}

function isLiteralNode(node: Node) {
  return node.type.endsWith('Literal')
}

/**
 * Analyze bindings in normal `<script>`
 * Note that `compileScriptSetup` already analyzes bindings as part of its
 * compilation process so this should only be used on single `<script>` SFCs.
 */
function analyzeScriptBindings(ast: Statement[]): BindingMetadata {
  for (const node of ast) {
    if (
      node.type === 'ExportDefaultDeclaration' &&
      node.declaration.type === 'ObjectExpression'
    ) {
      return analyzeBindingsFromOptions(node.declaration)
    }
  }
  return {}
}

function analyzeBindingsFromOptions(node: ObjectExpression): BindingMetadata {
  const bindings: BindingMetadata = {}
  // #3270, #3275
  // mark non-script-setup so we don't resolve components/directives from these
  Object.defineProperty(bindings, '__isScriptSetup', {
    enumerable: false,
    value: false
  })
  for (const property of node.properties) {
    if (
      property.type === 'ObjectProperty' &&
      !property.computed &&
      property.key.type === 'Identifier'
    ) {
      // props
      if (property.key.name === 'props') {
        // props: ['foo']
        // props: { foo: ... }
        for (const key of getObjectOrArrayExpressionKeys(property.value)) {
          bindings[key] = BindingTypes.PROPS
        }
      }

      // inject
      else if (property.key.name === 'inject') {
        // inject: ['foo']
        // inject: { foo: {} }
        for (const key of getObjectOrArrayExpressionKeys(property.value)) {
          bindings[key] = BindingTypes.OPTIONS
        }
      }

      // computed & methods
      else if (
        property.value.type === 'ObjectExpression' &&
        (property.key.name === 'computed' || property.key.name === 'methods')
      ) {
        // methods: { foo() {} }
        // computed: { foo() {} }
        for (const key of getObjectExpressionKeys(property.value)) {
          bindings[key] = BindingTypes.OPTIONS
        }
      }
    }

    // setup & data
    else if (
      property.type === 'ObjectMethod' &&
      property.key.type === 'Identifier' &&
      (property.key.name === 'setup' || property.key.name === 'data')
    ) {
      for (const bodyItem of property.body.body) {
        // setup() {
        //   return {
        //     foo: null
        //   }
        // }
        if (
          bodyItem.type === 'ReturnStatement' &&
          bodyItem.argument &&
          bodyItem.argument.type === 'ObjectExpression'
        ) {
          for (const key of getObjectExpressionKeys(bodyItem.argument)) {
            bindings[key] =
              property.key.name === 'setup'
                ? BindingTypes.SETUP_MAYBE_REF
                : BindingTypes.DATA
          }
        }
      }
    }
  }

  return bindings
}

function getObjectExpressionKeys(node: ObjectExpression): string[] {
  const keys = []
  for (const prop of node.properties) {
    if (prop.type === 'SpreadElement') continue
    const key = resolveObjectKey(prop.key, prop.computed)
    if (key) keys.push(String(key))
  }
  return keys
}

function getArrayExpressionKeys(node: ArrayExpression): string[] {
  const keys = []
  for (const element of node.elements) {
    if (element && element.type === 'StringLiteral') {
      keys.push(element.value)
    }
  }
  return keys
}

function getObjectOrArrayExpressionKeys(value: Node): string[] {
  if (value.type === 'ArrayExpression') {
    return getArrayExpressionKeys(value)
  }
  if (value.type === 'ObjectExpression') {
    return getObjectExpressionKeys(value)
  }
  return []
}

const templateUsageCheckCache = createCache<string>()

function resolveTemplateUsageCheckString(sfc: SFCDescriptor) {
  const { content, ast } = sfc.template!
  const cached = templateUsageCheckCache.get(content)
  if (cached) {
    return cached
  }

  let code = ''
  transform(createRoot([ast]), {
    nodeTransforms: [
      node => {
        if (node.type === NodeTypes.ELEMENT) {
          if (
            !parserOptions.isNativeTag!(node.tag) &&
            !parserOptions.isBuiltInComponent!(node.tag)
          ) {
            code += `,${camelize(node.tag)},${capitalize(camelize(node.tag))}`
          }
          for (let i = 0; i < node.props.length; i++) {
            const prop = node.props[i]
            if (prop.type === NodeTypes.DIRECTIVE) {
              if (!isBuiltInDir(prop.name)) {
                code += `,v${capitalize(camelize(prop.name))}`
              }
              if (prop.exp) {
                code += `,${processExp(
                  (prop.exp as SimpleExpressionNode).content,
                  prop.name
                )}`
              }
            }
          }
        } else if (node.type === NodeTypes.INTERPOLATION) {
          code += `,${processExp(
            (node.content as SimpleExpressionNode).content
          )}`
        }
      }
    ]
  })

  code += ';'
  templateUsageCheckCache.set(content, code)
  return code
}

const forAliasRE = /([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)/

function processExp(exp: string, dir?: string): string {
  if (/ as\s+\w|<.*>|:/.test(exp)) {
    if (dir === 'slot') {
      exp = `(${exp})=>{}`
    } else if (dir === 'on') {
      exp = `()=>{return ${exp}}`
    } else if (dir === 'for') {
      const inMatch = exp.match(forAliasRE)
      if (inMatch) {
        const [, LHS, RHS] = inMatch
        return processExp(`(${LHS})=>{}`) + processExp(RHS)
      }
    }
    let ret = ''
    // has potential type cast or generic arguments that uses types
    const ast = parseExpression(exp, { plugins: ['typescript'] })
    walkIdentifiers(ast, node => {
      ret += `,` + node.name
    })
    return ret
  }
  return stripStrings(exp)
}

function stripStrings(exp: string) {
  return exp
    .replace(/'[^']*'|"[^"]*"/g, '')
    .replace(/`[^`]+`/g, stripTemplateString)
}

function stripTemplateString(str: string): string {
  const interpMatch = str.match(/\${[^}]+}/g)
  if (interpMatch) {
    return interpMatch.map(m => m.slice(2, -1)).join(',')
  }
  return ''
}

function isImportUsed(local: string, sfc: SFCDescriptor): boolean {
  return new RegExp(
    // #4274 escape $ since it's a special char in regex
    // (and is the only regex special char that is valid in identifiers)
    `[^\\w$_]${local.replace(/\$/g, '\\$')}[^\\w$_]`
  ).test(resolveTemplateUsageCheckString(sfc))
}

/**
 * Note: this comparison assumes the prev/next script are already identical,
 * and only checks the special case where <script setup lang="ts"> unused import
 * pruning result changes due to template changes.
 */
export function hmrShouldReload(
  prevImports: Record<string, ImportBinding>,
  next: SFCDescriptor
): boolean {
  if (
    !next.scriptSetup ||
    (next.scriptSetup.lang !== 'ts' && next.scriptSetup.lang !== 'tsx')
  ) {
    return false
  }

  // for each previous import, check if its used status remain the same based on
  // the next descriptor's template
  for (const key in prevImports) {
    // if an import was previous unused, but now is used, we need to force
    // reload so that the script now includes that import.
    if (!prevImports[key].isUsedInTemplate && isImportUsed(key, next)) {
      return true
    }
  }

  return false
}
