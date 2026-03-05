export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface Theme {
  name: string;
  label: string;
  isDark: boolean;
  bg: string;
  fg: string;
  headerBg: string;
  drawerBg: string;
  border: string;
  textSecondary: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  userColor: string;
  selectedBg: string;
  terminal: TerminalColors;
}

export const themes: Record<string, Theme> = {
  'github-dark': {
    name: 'github-dark',
    label: 'GitHub Dark',
    isDark: true,
    bg: '#0d1117',
    fg: '#c9d1d9',
    headerBg: '#161b22',
    drawerBg: '#161b22',
    border: '#30363d',
    textSecondary: '#8b949e',
    accent: '#58a6ff',
    success: '#3fb950',
    warning: '#d29922',
    error: '#f85149',
    userColor: '#7ee787',
    selectedBg: '#0d1117',
    terminal: {
      background: '#0d1117',
      foreground: '#e6edf3',
      cursor: '#58a6ff',
      selectionBackground: '#264f78',
      black: '#484f58',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#b1bac4',
      brightBlack: '#6e7681',
      brightRed: '#ffa198',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd',
      brightWhite: '#f0f6fc',
    },
  },
  dracula: {
    name: 'dracula',
    label: 'Dracula',
    isDark: true,
    bg: '#282a36',
    fg: '#f8f8f2',
    headerBg: '#21222c',
    drawerBg: '#21222c',
    border: '#44475a',
    textSecondary: '#6272a4',
    accent: '#8be9fd',
    success: '#50fa7b',
    warning: '#f1fa8c',
    error: '#ff5555',
    userColor: '#50fa7b',
    selectedBg: '#282a36',
    terminal: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
  },
  nord: {
    name: 'nord',
    label: 'Nord',
    isDark: true,
    bg: '#2e3440',
    fg: '#d8dee9',
    headerBg: '#3b4252',
    drawerBg: '#3b4252',
    border: '#4c566a',
    textSecondary: '#81a1c1',
    accent: '#88c0d0',
    success: '#a3be8c',
    warning: '#ebcb8b',
    error: '#bf616a',
    userColor: '#a3be8c',
    selectedBg: '#2e3440',
    terminal: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    },
  },
  monokai: {
    name: 'monokai',
    label: 'Monokai',
    isDark: true,
    bg: '#272822',
    fg: '#f8f8f2',
    headerBg: '#1e1f1c',
    drawerBg: '#1e1f1c',
    border: '#3e3d32',
    textSecondary: '#75715e',
    accent: '#66d9ef',
    success: '#a6e22e',
    warning: '#e6db74',
    error: '#f92672',
    userColor: '#a6e22e',
    selectedBg: '#272822',
    terminal: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      selectionBackground: '#49483e',
      black: '#272822',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#f4bf75',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#a1efe4',
      white: '#f8f8f2',
      brightBlack: '#75715e',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#f4bf75',
      brightBlue: '#66d9ef',
      brightMagenta: '#ae81ff',
      brightCyan: '#a1efe4',
      brightWhite: '#f9f8f5',
    },
  },
  'solarized-dark': {
    name: 'solarized-dark',
    label: 'Solarized Dark',
    isDark: true,
    bg: '#002b36',
    fg: '#839496',
    headerBg: '#073642',
    drawerBg: '#073642',
    border: '#586e75',
    textSecondary: '#657b83',
    accent: '#268bd2',
    success: '#859900',
    warning: '#b58900',
    error: '#dc322f',
    userColor: '#859900',
    selectedBg: '#002b36',
    terminal: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#839496',
      selectionBackground: '#073642',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#859900',
      brightYellow: '#b58900',
      brightBlue: '#268bd2',
      brightMagenta: '#6c71c4',
      brightCyan: '#2aa198',
      brightWhite: '#fdf6e3',
    },
  },
  'solarized-light': {
    name: 'solarized-light',
    label: 'Solarized Light',
    isDark: false,
    bg: '#fdf6e3',
    fg: '#657b83',
    headerBg: '#eee8d5',
    drawerBg: '#eee8d5',
    border: '#93a1a1',
    textSecondary: '#93a1a1',
    accent: '#268bd2',
    success: '#859900',
    warning: '#b58900',
    error: '#dc322f',
    userColor: '#859900',
    selectedBg: '#fdf6e3',
    terminal: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#657b83',
      selectionBackground: '#eee8d5',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#859900',
      brightYellow: '#b58900',
      brightBlue: '#268bd2',
      brightMagenta: '#6c71c4',
      brightCyan: '#2aa198',
      brightWhite: '#fdf6e3',
    },
  },
};

export const themeNames = Object.keys(themes);
export const defaultTheme = 'solarized-light';

/** Apply theme CSS variables to the document */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.style.setProperty('--bg', theme.bg);
  root.style.setProperty('--fg', theme.fg);
  root.style.setProperty('--header-bg', theme.headerBg);
  root.style.setProperty('--drawer-bg', theme.drawerBg);
  root.style.setProperty('--border', theme.border);
  root.style.setProperty('--text-secondary', theme.textSecondary);
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--success', theme.success);
  root.style.setProperty('--warning', theme.warning);
  root.style.setProperty('--error', theme.error);
  root.style.setProperty('--user-color', theme.userColor);
  root.style.setProperty('--selected-bg', theme.selectedBg);
  root.style.setProperty('--terminal-bg', theme.terminal.background);
}
