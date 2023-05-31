import { SFCScriptCompileOptions, PropsDeclType } from '../compileScript'
import { SFCDescriptor } from '../parse'
import {
  ParserOptions,
  ParserPlugin,
  parse as babelParser
} from '@babel/parser'
import { Node, Program } from '@babel/types'
import { generateCodeFrame } from '@vue/shared'

export default class ScriptCompileContext {
  isJS: boolean
  isTS: boolean
  scriptAst: Program | null
  scriptSetupAst: Program | null

  startOffset = this.descriptor.scriptSetup?.loc.start.offset
  endOffset = this.descriptor.scriptSetup?.loc.end.offset

  scriptStartOffset = this.descriptor.script?.loc.start.offset
  scriptEndOffset = this.descriptor.script?.loc.end.offset

  //macros
  hasDefinePropsCall = false
  hasDefineEmitCall = false
  hasDefineExposeCall = false
  hasDefaultExportName = false
  hasDefaultExportRender = false
  hasDefineOptionsCall = false
  hasDefineSlotsCall = false
  hasDefineModelCall = false

  //props
  propsIdentifier: string | undefined
  propsRuntimeDecl: Node | undefined
  propsRuntimeDefaults: Node | undefined
  propsDestructureDecl: Node | undefined
  propsDestructureRestId: string | undefined
  propsTypeDecl: PropsDeclType | undefined

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

    // resolve parser plugins
    const plugins: ParserPlugin[] = []
    if (!this.isTS || scriptLang === 'tsx' || scriptSetupLang === 'tsx') {
      plugins.push('jsx')
    } else {
      // If don't match the case of adding jsx, should remove the jsx from the babelParserPlugins
      if (options.babelParserPlugins)
        options.babelParserPlugins = options.babelParserPlugins.filter(
          n => n !== 'jsx'
        )
    }
    if (options.babelParserPlugins) plugins.push(...options.babelParserPlugins)
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
        return babelParser(input, options).program
      } catch (e: any) {
        e.message = `[@vue/compiler-sfc] ${e.message}\n\n${
          descriptor.filename
        }\n${generateCodeFrame(
          descriptor.source,
          e.pos + offset,
          e.pos + offset + 1
        )}`
        throw e
      }
    }

    this.scriptAst =
      script &&
      parse(
        script.content,
        { plugins, sourceType: 'module' },
        this.scriptStartOffset!
      )
    this.scriptSetupAst =
      scriptSetup &&
      parse(
        scriptSetup.content,
        { plugins: [...plugins, 'topLevelAwait'], sourceType: 'module' },
        this.startOffset!
      )
  }

  error(
    msg: string,
    node: Node,
    end: number = node.end! + this.startOffset!
  ): never {
    throw new Error(
      `[@vue/compiler-sfc] ${msg}\n\n${
        this.descriptor.filename
      }\n${generateCodeFrame(
        this.descriptor.source,
        node.start! + this.startOffset!,
        end
      )}`
    )
  }
}
