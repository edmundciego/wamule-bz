export type UploadKind = "payment-document" | "signed-contract" | "business-asset";

export type PreparedUploadFile = {
  originalFile: File;
  uploadFile: File;
  originalSize: number;
  uploadSize: number;
  savingsPercent: number;
  wasCompressed: boolean;
};

const allowedMimeTypes = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
const imageMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;
const maxImageWidth = 1600;
const imageQuality = 0.78;

const limitsByKind: Record<UploadKind, { pdfMaxBytes: number; label: string; allowPdf: boolean }> = {
  "payment-document": {
    pdfMaxBytes: 10 * 1024 * 1024,
    label: "Payment documents",
    allowPdf: true,
  },
  "signed-contract": {
    pdfMaxBytes: 20 * 1024 * 1024,
    label: "Signed contracts",
    allowPdf: true,
  },
  "business-asset": {
    pdfMaxBytes: 0,
    label: "Business assets",
    allowPdf: false,
  },
};

export function getUploadLimits(kind: UploadKind) {
  return limitsByKind[kind];
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function validateUploadFile(file: File, kind: UploadKind) {
  const limits = getUploadLimits(kind);
  if (!allowedMimeTypes.includes(file.type as (typeof allowedMimeTypes)[number])) {
    return {
      valid: false,
      message: "Unsupported file type. Upload a PDF, JPG, PNG, or WEBP file.",
    };
  }

  if (file.type === "application/pdf") {
    if (!limits.allowPdf) {
      return {
        valid: false,
        message: "Unsupported file type. Upload a JPG, PNG, or WEBP image.",
      };
    }
    if (file.size > limits.pdfMaxBytes) {
      return {
        valid: false,
        message: "File is too large. Please upload a smaller PDF or compress it before uploading.",
      };
    }
  }

  return { valid: true, message: null };
}

export async function prepareUploadFile(file: File, kind: UploadKind) {
  const validation = validateUploadFile(file, kind);
  if (!validation.valid) {
    throw new Error(validation.message ?? "File cannot be uploaded.");
  }

  if (isImageFile(file)) {
    return compressImageFile(file);
  }

  return {
    originalFile: file,
    uploadFile: file,
    originalSize: file.size,
    uploadSize: file.size,
    savingsPercent: 0,
    wasCompressed: false,
  };
}

export async function compressImageFile(file: File): Promise<PreparedUploadFile> {
  try {
    const image = await loadImage(file);
    const scale = image.width > maxImageWidth ? maxImageWidth / image.width : 1;
    const width = Math.round(image.width * scale);
    const height = Math.round(image.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await canvasToBlob(canvas);
    const compressedFile = new File([blob], replaceExtension(file.name, "jpg"), {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
    const uploadFile = compressedFile.size < file.size ? compressedFile : file;
    const savingsPercent = Math.max(0, Math.round(((file.size - uploadFile.size) / file.size) * 100));

    return {
      originalFile: file,
      uploadFile,
      originalSize: file.size,
      uploadSize: uploadFile.size,
      savingsPercent,
      wasCompressed: uploadFile !== file,
    };
  } catch {
    throw new Error("Image compression failed. Please try another file or upload a smaller image.");
  }
}

export function isImageFile(file: File) {
  return imageMimeTypes.includes(file.type as (typeof imageMimeTypes)[number]);
}

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image could not be loaded."));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Image compression failed."));
      },
      "image/jpeg",
      imageQuality,
    );
  });
}

function replaceExtension(fileName: string, extension: string) {
  return fileName.replace(/\.[^.]+$/, "") + `.${extension}`;
}
