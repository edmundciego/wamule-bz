function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

export const featureFlags = {
  informationCentre: enabled(import.meta.env.VITE_ENABLE_INFORMATION_CENTRE),
};
