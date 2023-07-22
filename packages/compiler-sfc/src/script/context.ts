import { Node, ObjectPattern, Program } from '@babel/types'
import { SFCDescriptor } from '../parse'
import { SFCScriptCompileOptions } from '../compileScript'
import { parse as babelParse, ParserOptions, ParserPlugin } from '@babel/parser'
import { generateCodeFrame } from '@vue/shared'
import {
  PropsDeclType,
  PropsDestructureBindings,
  PropTypeData
} from './defineProps'
import { ModelDecl } from './defineModel'

export class ScriptCompileContext {
  isJS: boolean
  isTS: boolean

  scriptAST: Program | null
  scriptSetupAST: Program | null

  scriptStartOffset = this.descriptor.script?.loc.start.offset
  scriptEndOffset = this.descriptor.script?.loc.end.offset

  helperImports: Set<string> = new Set()
  helper(key: string): string {
    this.helperImports.add(key)
    return `_${key}`
  }

  declaredTypes: Record<string, string[]> = Object.create(null)
  // macros presence check
  hasDefinePropsCall = false
  hasDefineEmitCall = false
  hasDefineExposeCall = false
  hasDefaultExportName = false
  hasDefaultExportRender = false
  hasDefineOptionsCall = false
  hasDefineSlotsCall = false
  hasDefineModelCall = false

  propsIdentifier: string | undefined
  propsRuntimeDecl: Node | undefined
  propsDestructureDecl: ObjectPattern | undefined
  propsTypeDecl: PropsDeclType | undefined
  propsDestructureRestId: string | undefined
  propsRuntimeDefaults: Node | undefined
  propsDestructuredBindings: PropsDestructureBindings = Object.create(null)
  typeDeclaredProps: Record<string, PropTypeData> = {}
  // defineModel
  modelDecls: Record<string, ModelDecl> = {}
  constructor(
    public descriptor: SFCDescriptor,
    public options: SFCScriptCompileOptions
  ) {
    const { script, scriptSetup } = descriptor
    const scriptLang = script && script.lang
    const scriptSetupLang = scriptSetup && scriptSetup.lang

    this.isJS =
      scriptLang === 'js' ||
      scriptLang === 'jsx' ||
      scriptSetupLang === 'js' ||
      scriptSetupLang === 'jsx'

    this.isTS =
      scriptLang === 'ts' ||
      scriptLang === 'tsx' ||
      scriptSetupLang === 'ts' ||
      scriptSetupLang === 'tsx'

    //resolve parser plugins
    //TODO:为什么要添加parserPlugin
    const plugins: ParserPlugin[] = []
    if (!this.isTS || scriptLang === 'tsx' || scriptSetupLang === 'tsx') {
      plugins.push('jsx')
    } else {
      if (options.babelParserPlugins)
        options.babelParserPlugins = options.babelParserPlugins.filter(
          n => n !== 'jsx'
        )
    }
    if (options.babelParserPlugins) {
      plugins.push(...options.babelParserPlugins)
    }
    if (this.isTS) {
      plugins.push('typescript')
      if (!plugins.includes('decorators')) {
        plugins.push('decorators-legacy')
      }
    }

    function parse(
      input: string,
      options: ParserOptions,
      offset: number
    ): Program {
      try {
        return babelParse(input, options).program
      } catch (e: any) {
        e.message = `[@vue/compiler-sfc]${e.message}\n\n${
          descriptor.filename
        }\n${generateCodeFrame(
          descriptor.source,
          e.pos + offset,
          e.pos + offset + 1
        )}`

        throw e
      }
    }

    this.scriptAST =
      this.descriptor.script &&
      parse(
        this.descriptor.script.content,
        {
          plugins,
          sourceType: 'module'
        },
        this.scriptStartOffset!
      )

    this.scriptSetupAST =
      this.descriptor.scriptSetup &&
      parse(
        this.descriptor.scriptSetup.content,
        {
          plugins: [...plugins, 'topLevelAwait'],
          sourceType: 'module'
        },
        this.scriptStartOffset!
      )
  }

  getString(node: Node, scriptSetup = true): string {
    const block = scriptSetup
      ? this.descriptor.scriptSetup!
      : this.descriptor.script!
    return block.content.slice(node.start!, node.end!)
  }

  error(
    msg: string,
    node: Node,
    end: number = node.end! + this.scriptStartOffset!
  ): never {
    throw new Error(`
        [@vue/compiler-sfc]${msg}\n\n${
      this.descriptor.filename
    }\n${generateCodeFrame(
      this.descriptor.source,
      node.start! + this.scriptStartOffset!,
      end
    )}
        `)
  }
}
