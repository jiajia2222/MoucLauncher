export { createCrashService, MAX_REPORTS, extractCrashBlock, type CrashServiceDeps } from './analyzer'
export { buildCrashModel, sectionLines, MAX_FRAMES, type CrashModel } from './parse'
export {
  CRASH_RULES,
  CLASS_FILE_MAJOR_TO_JAVA,
  PACKAGE_PREFIX_TO_MOD,
  FALLBACK_ANALYSIS,
  javaForClassMajor,
  likelyModForClass,
  type CrashRule,
  type CrashSeverity,
  type CrashMatchContext
} from './rules'
