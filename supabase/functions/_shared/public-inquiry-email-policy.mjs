export function shouldSuppressPublicInquiryEmail(mapExperienceMode, suppressSetting) {
  return mapExperienceMode === "demo" || suppressSetting === "true";
}
