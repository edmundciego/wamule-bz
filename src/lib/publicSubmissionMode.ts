/** Local and explicit staging-preview builds never post public form data. */
export const isLocalOnlySubmission = import.meta.env.DEV || import.meta.env.VITE_PUBLIC_DEMO_MODE === "true";
