/** Change visible brand here. Never use visible branding as project IDs or storage keys. */
export const BRAND = {
  code: 'gomo',
  suiteKo: '고모 미디어공방',
  suiteEn: 'GOMO Media Workshop',
  companyMark: 'GOMO',
  productKo: '고모 창작실',
  productEn: 'GOMO Create',
  tagline: '아이디어에서 장면까지, 하나의 창작 흐름',
  colors: { accent: '#ef845e', accentHover: '#ff9b76', dark: '#121519' }
} as const;
export const INTERNAL = {
  /** These stay stable even after a future GOMO → NUNI rebrand. */
  projectSchema: 'creator.project.v1',
  handoffSchema: 'creator.handoff.v1',
  storageNamespace: 'creator-workspace',
  appId: 'com.gomoworkshop.creator' // changing this requires a Windows install-data migration
} as const;
