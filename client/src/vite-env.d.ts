/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the deployed API (e.g. https://elim-erp-api.onrender.com). */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
