import type { GooglePickerSession } from '@clipforge/shared';

declare global {
  interface Window {
    gapi?: {
      load: (
        apiName: string,
        options:
          | (() => void)
          | {
              callback: () => void;
              onerror?: () => void;
              timeout?: number;
              ontimeout?: () => void;
            }
      ) => void;
    };
    google?: {
      picker?: any;
    };
  }
}

export interface PickedGoogleDriveDocument {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  thumbnailUrl?: string;
}

const GOOGLE_API_SCRIPT_SRC = 'https://apis.google.com/js/api.js';
let pickerSdkLoadPromise: Promise<void> | null = null;

export function loadGooglePickerSdk(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google Picker requires a browser environment.'));
  }

  if (window.google?.picker) {
    return Promise.resolve();
  }

  if (pickerSdkLoadPromise) {
    return pickerSdkLoadPromise;
  }

  pickerSdkLoadPromise = new Promise<void>((resolve, reject) => {
    const initPickerModule = () => {
      if (!window.gapi?.load) {
        pickerSdkLoadPromise = null;
        reject(new Error('Google API loader (gapi) failed to initialize.'));
        return;
      }
      window.gapi.load('picker', {
        callback: () => {
          if (window.google?.picker) {
            resolve();
          } else {
            pickerSdkLoadPromise = null;
            reject(new Error('Google Picker API module did not initialize.'));
          }
        },
        onerror: () => {
          pickerSdkLoadPromise = null;
          reject(new Error('Failed to load Google Picker module.'));
        },
        timeout: 12000,
        ontimeout: () => {
          pickerSdkLoadPromise = null;
          reject(new Error('Timed out while loading Google Picker module.'));
        },
      });
    };

    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_API_SCRIPT_SRC}"]`
    );
    if (existingScript) {
      if (window.gapi?.load) {
        initPickerModule();
      } else {
        existingScript.addEventListener('load', initPickerModule, { once: true });
        existingScript.addEventListener(
          'error',
          () => {
            pickerSdkLoadPromise = null;
            reject(new Error('Failed to load https://apis.google.com/js/api.js'));
          },
          { once: true }
        );
      }
      return;
    }

    const script = document.createElement('script');
    script.src = GOOGLE_API_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = initPickerModule;
    script.onerror = () => {
      pickerSdkLoadPromise = null;
      reject(
        new Error(
          'Unable to load Google Picker script (https://apis.google.com/js/api.js). Check your internet connection or ad-blocker.'
        )
      );
    };
    document.head.appendChild(script);
  });

  return pickerSdkLoadPromise;
}

export async function openGoogleDriveVideoPicker(
  session: GooglePickerSession
): Promise<PickedGoogleDriveDocument | null> {
  if (!session.apiKey || !session.appId) {
    throw new Error(
      'Google Picker requires GOOGLE_API_KEY and GOOGLE_PROJECT_NUMBER to be configured in the backend environment.'
    );
  }
  if (!session.accessToken) {
    throw new Error('Missing short-lived Google OAuth access token for Picker.');
  }

  await loadGooglePickerSdk();

  const pickerNs = window.google?.picker;
  if (!pickerNs) {
    throw new Error('Google Picker API is unavailable in this browser.');
  }

  const allowedMimeCsv = (
    session.supportedMimeTypes?.length
      ? session.supportedMimeTypes
      : ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-m4v']
  ).join(',');

  return new Promise<PickedGoogleDriveDocument | null>((resolve, reject) => {
    try {
      const videoView = new pickerNs.DocsView(pickerNs.ViewId.DOCS_VIDEOS)
        .setMimeTypes(allowedMimeCsv)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false);

      const builder = new pickerNs.PickerBuilder()
        .addView(videoView)
        .setOAuthToken(session.accessToken)
        .setDeveloperKey(session.apiKey)
        .setAppId(session.appId)
        .setOrigin(window.location.origin)
        .setMaxItems(1)
        .setTitle('Select a Video from Google Drive')
        .setCallback((data: any) => {
          const action = data?.[pickerNs.Response.ACTION];
          if (action === pickerNs.Action.PICKED) {
            const docs = data?.[pickerNs.Response.DOCUMENTS];
            const first = Array.isArray(docs) ? docs[0] : null;
            if (!first?.id) {
              resolve(null);
              return;
            }
            const rawSize =
              first[pickerNs.Document.SIZE_BYTES] ?? first.sizeBytes ?? null;
            const thumbs = first[pickerNs.Document.THUMBNAILS] ?? first.thumbnails;
            const thumbUrl =
              Array.isArray(thumbs) && thumbs.length > 0
                ? thumbs[thumbs.length - 1]?.url || thumbs[0]?.url
                : typeof first.iconUrl === 'string'
                  ? first.iconUrl
                  : undefined;

            resolve({
              id: String(first[pickerNs.Document.ID] || first.id),
              name: String(
                first[pickerNs.Document.NAME] || first.name || 'Google Drive Video'
              ),
              mimeType: String(
                first[pickerNs.Document.MIME_TYPE] || first.mimeType || 'video/mp4'
              ),
              sizeBytes:
                rawSize !== null && Number.isFinite(Number(rawSize))
                  ? Number(rawSize)
                  : null,
              thumbnailUrl: thumbUrl ? String(thumbUrl) : undefined,
            });
          } else if (action === pickerNs.Action.CANCEL) {
            resolve(null);
          }
        });

      const picker = builder.build();
      picker.setVisible(true);
    } catch (err) {
      reject(err);
    }
  });
}
