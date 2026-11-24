/**
 * Theme system for GOMO Create.
 * Semantic design tokens — brand-agnostic (survives GOMO → NUNI).
 */

export type ThemeId = 'light-blue' | 'warm-cream' | 'silver-light' | 'dark';

export interface ThemeTokens {
  // App shell
  '--color-bg': string;
  '--color-sidebar': string;
  '--color-topbar': string;
  '--color-statusbar': string;

  // Surfaces
  '--color-surface': string;
  '--color-surface-raised': string;
  '--color-surface-overlay': string;

  // Text
  '--color-text': string;
  '--color-text-secondary': string;
  '--color-text-muted': string;
  '--color-text-disabled': string;
  '--color-text-on-primary': string;

  // Borders
  '--color-border': string;
  '--color-border-strong': string;
  '--color-divider': string;

  // Primary / Accent
  '--color-primary': string;
  '--color-primary-hover': string;
  '--color-primary-active': string;
  '--color-primary-soft': string;

  // Secondary button
  '--color-secondary-bg': string;
  '--color-secondary-text': string;
  '--color-secondary-border': string;

  // Danger
  '--color-danger': string;
  '--color-danger-hover': string;
  '--color-danger-soft': string;

  // Inputs
  '--color-input-bg': string;
  '--color-input-border': string;
  '--color-input-border-hover': string;
  '--color-input-focus': string;

  // States
  '--color-success': string;
  '--color-success-soft': string;
  '--color-warning': string;
  '--color-warning-soft': string;
  '--color-error': string;
  '--color-error-soft': string;
  '--color-info': string;
  '--color-info-soft': string;

  // Selection / hover
  '--color-hover': string;
  '--color-selected': string;
  '--color-selected-text': string;

  // Scrollbar / misc
  '--color-scrollbar': string;
  '--color-shadow': string;
  '--color-selection-bg': string;
  '--color-selection-text': string;

  // Placeholder / empty
  '--color-placeholder': string;
  '--color-empty-icon': string;
}

export const THEMES: Record<ThemeId, ThemeTokens> = {
  'light-blue': {
    '--color-bg': '#F8FAFC',
    '--color-sidebar': '#F1F5F9',
    '--color-topbar': '#FFFFFF',
    '--color-statusbar': '#F8FAFC',
    '--color-surface': '#FFFFFF',
    '--color-surface-raised': '#FFFFFF',
    '--color-surface-overlay': '#FFFFFF',
    '--color-text': '#26374C',
    '--color-text-secondary': '#3D4F66',
    '--color-text-muted': '#61748A',
    '--color-text-disabled': '#94A3B8',
    '--color-text-on-primary': '#FFFFFF',
    '--color-border': '#DEE5ED',
    '--color-border-strong': '#C5D0DC',
    '--color-divider': '#E8EEF4',
    '--color-primary': '#427DB6',
    '--color-primary-hover': '#356A9E',
    '--color-primary-active': '#2A5785',
    '--color-primary-soft': '#E8F1F8',
    '--color-secondary-bg': '#F1F5F9',
    '--color-secondary-text': '#3D4F66',
    '--color-secondary-border': '#DEE5ED',
    '--color-danger': '#C45555',
    '--color-danger-hover': '#A94444',
    '--color-danger-soft': '#FDECEC',
    '--color-input-bg': '#FFFFFF',
    '--color-input-border': '#D0D8E2',
    '--color-input-border-hover': '#B0BCC9',
    '--color-input-focus': '#427DB6',
    '--color-success': '#2E8B6A',
    '--color-success-soft': '#E6F5EF',
    '--color-warning': '#B8860B',
    '--color-warning-soft': '#FFF8E6',
    '--color-error': '#C45555',
    '--color-error-soft': '#FDECEC',
    '--color-info': '#427DB6',
    '--color-info-soft': '#E8F1F8',
    '--color-hover': '#F0F4F8',
    '--color-selected': '#E3EEF7',
    '--color-selected-text': '#1E4D78',
    '--color-scrollbar': '#C5D0DC',
    '--color-shadow': 'rgba(38, 55, 76, 0.08)',
    '--color-selection-bg': '#C5DDF0',
    '--color-selection-text': '#1E3A5F',
    '--color-placeholder': '#94A3B8',
    '--color-empty-icon': '#94A3B8',
  },
  'warm-cream': {
    '--color-bg': '#FFF9F2',
    '--color-sidebar': '#F7EADD',
    '--color-topbar': '#FFFFFF',
    '--color-statusbar': '#FFF9F2',
    '--color-surface': '#FFFFFF',
    '--color-surface-raised': '#FFFCF8',
    '--color-surface-overlay': '#FFFFFF',
    '--color-text': '#57483A',
    '--color-text-secondary': '#6B5C4C',
    '--color-text-muted': '#806F60',
    '--color-text-disabled': '#B0A090',
    '--color-text-on-primary': '#FFFFFF',
    '--color-border': '#EFDFC9',
    '--color-border-strong': '#E0CDB5',
    '--color-divider': '#F3E8D8',
    '--color-primary': '#C57A38',
    '--color-primary-hover': '#B06A2E',
    '--color-primary-active': '#9A5A24',
    '--color-primary-soft': '#FBF0E4',
    '--color-secondary-bg': '#F7EADD',
    '--color-secondary-text': '#6B5C4C',
    '--color-secondary-border': '#EFDFC9',
    '--color-danger': '#B85C4A',
    '--color-danger-hover': '#9E4A3A',
    '--color-danger-soft': '#FDEEEA',
    '--color-input-bg': '#FFFFFF',
    '--color-input-border': '#E8D9C4',
    '--color-input-border-hover': '#D4C4A8',
    '--color-input-focus': '#C57A38',
    '--color-success': '#5A8F6A',
    '--color-success-soft': '#E8F4EC',
    '--color-warning': '#C49A3C',
    '--color-warning-soft': '#FDF6E6',
    '--color-error': '#B85C4A',
    '--color-error-soft': '#FDEEEA',
    '--color-info': '#C57A38',
    '--color-info-soft': '#FBF0E4',
    '--color-hover': '#FBF6F0',
    '--color-selected': '#F5E8D8',
    '--color-selected-text': '#7A4E1E',
    '--color-scrollbar': '#E0CDB5',
    '--color-shadow': 'rgba(87, 72, 58, 0.08)',
    '--color-selection-bg': '#F0D9B8',
    '--color-selection-text': '#4A3828',
    '--color-placeholder': '#B0A090',
    '--color-empty-icon': '#C4B4A0',
  },
  'silver-light': {
    '--color-bg': '#F2F4F6',
    '--color-sidebar': '#E9EDF1',
    '--color-topbar': '#FFFFFF',
    '--color-statusbar': '#F2F4F6',
    '--color-surface': '#FFFFFF',
    '--color-surface-raised': '#FFFFFF',
    '--color-surface-overlay': '#FFFFFF',
    '--color-text': '#333B45',
    '--color-text-secondary': '#4A5562',
    '--color-text-muted': '#667384',
    '--color-text-disabled': '#9AA3AE',
    '--color-text-on-primary': '#FFFFFF',
    '--color-border': '#D5D9DF',
    '--color-border-strong': '#C0C5CC',
    '--color-divider': '#E4E7EB',
    '--color-primary': '#61768B',
    '--color-primary-hover': '#4F6275',
    '--color-primary-active': '#3E4F5F',
    '--color-primary-soft': '#EEF1F4',
    '--color-secondary-bg': '#E9EDF1',
    '--color-secondary-text': '#4A5562',
    '--color-secondary-border': '#D5D9DF',
    '--color-danger': '#A85A5A',
    '--color-danger-hover': '#8E4A4A',
    '--color-danger-soft': '#F8EEEE',
    '--color-input-bg': '#FFFFFF',
    '--color-input-border': '#D0D4DA',
    '--color-input-border-hover': '#B8BEC6',
    '--color-input-focus': '#61768B',
    '--color-success': '#4A7A62',
    '--color-success-soft': '#E8F2EC',
    '--color-warning': '#A88A3A',
    '--color-warning-soft': '#F8F4E8',
    '--color-error': '#A85A5A',
    '--color-error-soft': '#F8EEEE',
    '--color-info': '#61768B',
    '--color-info-soft': '#EEF1F4',
    '--color-hover': '#F0F2F4',
    '--color-selected': '#E4E9EE',
    '--color-selected-text': '#3A4A5A',
    '--color-scrollbar': '#C0C5CC',
    '--color-shadow': 'rgba(51, 59, 69, 0.08)',
    '--color-selection-bg': '#D0D8E0',
    '--color-selection-text': '#2A343E',
    '--color-placeholder': '#9AA3AE',
    '--color-empty-icon': '#A8B0B8',
  },
  dark: {
    '--color-bg': '#111317',
    '--color-sidebar': '#16181D',
    '--color-topbar': '#15171B',
    '--color-statusbar': '#15171B',
    '--color-surface': '#1B1E23',
    '--color-surface-raised': '#22262C',
    '--color-surface-overlay': '#282C33',
    '--color-text': '#EBECEF',
    '--color-text-secondary': '#C8CCD2',
    '--color-text-muted': '#A0A3AB',
    '--color-text-disabled': '#747B86',
    '--color-text-on-primary': '#1B1512',
    '--color-border': '#30343C',
    '--color-border-strong': '#3E444E',
    '--color-divider': '#2A2E34',
    '--color-primary': '#EF845E',
    '--color-primary-hover': '#FF9B76',
    '--color-primary-active': '#E07050',
    '--color-primary-soft': '#3A2A22',
    '--color-secondary-bg': '#22262C',
    '--color-secondary-text': '#C8CCD2',
    '--color-secondary-border': '#3E444E',
    '--color-danger': '#E07070',
    '--color-danger-hover': '#FF8888',
    '--color-danger-soft': '#3A2424',
    '--color-input-bg': '#15181D',
    '--color-input-border': '#383C45',
    '--color-input-border-hover': '#555964',
    '--color-input-focus': '#EF845E',
    '--color-success': '#83C6A6',
    '--color-success-soft': '#1E3328',
    '--color-warning': '#E7BC78',
    '--color-warning-soft': '#332C1E',
    '--color-error': '#E07070',
    '--color-error-soft': '#3A2424',
    '--color-info': '#EF845E',
    '--color-info-soft': '#3A2A22',
    '--color-hover': '#22262C',
    '--color-selected': '#2A3038',
    '--color-selected-text': '#FF9B76',
    '--color-scrollbar': '#444951',
    '--color-shadow': 'rgba(0, 0, 0, 0.4)',
    '--color-selection-bg': '#EE875F65',
    '--color-selection-text': '#FFFFFF',
    '--color-placeholder': '#747B86',
    '--color-empty-icon': '#747B86',
  },
};

export const THEME_META: Record<ThemeId, { name: string; nameEn: string; description: string }> = {
  'light-blue': { name: '화이트 블루', nameEn: 'White Blue', description: '깨끗하고 전문적인 기본 테마' },
  'warm-cream': { name: '웜 크림', nameEn: 'Warm Cream', description: '따뜻하고 편안한 창작 공간' },
  'silver-light': { name: '실버 라이트', nameEn: 'Silver Light', description: '절제된 고급 업무 스타일' },
  dark: { name: '다크', nameEn: 'Dark', description: '기존 다크 테마 유지' },
};

export const DEFAULT_THEME: ThemeId = 'light-blue';
export const STORAGE_KEY = 'creator-theme';
export const SYSTEM_SYNC_KEY = 'creator-theme-system-sync';
