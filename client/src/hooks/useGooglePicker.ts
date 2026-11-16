import { useCallback, useEffect, useRef, useState } from 'react';
import { GOOGLE_DRIVE_SUPPORTED_MIME_TYPES } from '@clipforge/shared';

const PICKER_SCRIPT_URL = 'https://apis.google.com/js/api.js';

export interface PickerPickedDocument {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  thumbnailUrl: string | null;
}

export interface OpenPickerOptions {
  apiKey: string;
  projectNumber: string;
  oauthToken: string;
  mimeTypes?: readonly string[];
}

interface GooglePickerGlobals {
  google: any;
  gapi: any;
}

function globals(): GooglePickerGlobals {
  return window as unknown as GooglePickerGlobals;
}

let scriptLoadPromise: Promise<void> | null = null;

/** Loads the official Google Picker API script once (gapi + google.picker). */
function loadPickerApi(): Promise<void> {
  const g = globals();
  if (g.google?.picker?.PickerBuilder && g.gapi?.load) return Promise.resolve();
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${PICKER_SCRIPT_URL}"]`
    );
    const script = existing || document.createElement('script');
    const onReady = () => {
      const api = globals();
      if (!api.gapi?.load) {
        reject(new Error('Google API script loaded without gapi.load'));
        return;
      }
      api.gapi.load('picker', {
        callback: () => {
          if (globals().google?.picker?.PickerBuilder) resolve();
          else reject(new Error('Google Picker API failed to initialize'));
        },
        onerror: () => reject(new Error('Failed to load the Google Picker API')),
      });
    };

    if (existing) {
      if (g.google?.picker?.PickerBuilder) resolve();
      else {
        existing.addEventListener('load', onReady, { once: true });
        existing.addEventListener(
          'error',
          () => reject(new Error('Failed to load the Google Picker API script')),
          { once: true }
        );
      }
      return;
    }

    script.src = PICKER_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = onReady;
    script.onerror = () => reject(new Error('Failed to load the Google Picker API script'));
    document.head.appendChild(script);
  }).catch((err) => {
    scriptLoadPromise = null;
    throw err;
  });

  return scriptLoadPromise;
}

/**
 * React hook around the official Google Picker API.
 * Only a short-lived OAuth access token and the browser-restricted Picker API key
 * are passed to Google; the OAuth client secret and refresh token stay on the server.
 */
export function useGooglePicker() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const openPicker = useCallback(
    async (options: OpenPickerOptions): Promise<PickerPickedDocument | null> => {
      setLoading(true);
      setError(null);
      try {
        await loadPickerApi();
        const { google } = globals();
        const picker = google?.picker;
        if (!picker?.PickerBuilder || !picker?.DocsView) {
          throw new Error('Google Picker API is unavailable in this browser');
        }
        if (!options.apiKey || !options.projectNumber) {
          throw new Error(
            'Google Picker is not configured (GOOGLE_API_KEY / GOOGLE_PROJECT_NUMBER missing on the server).'
          );
        }

        const mimeTypes = options.mimeTypes || GOOGLE_DRIVE_SUPPORTED_MIME_TYPES;
        const docsView = new picker.DocsView(picker.ViewId.DOCS)
          .setIncludeFolders(true)
          .setMimeTypes(mimeTypes.join(','));
        if (typeof docsView.setSelectFolderEnabled === 'function') {
          docsView.setSelectFolderEnabled(false);
        }

        return await new Promise<PickerPickedDocument | null>((resolve, reject) => {
          let pickerInstance: any;
          const callback = (data: any) => {
            const action = String(data?.action || '');
            if (action === String(picker.Action.CANCEL) || action === 'cancel') {
              setLoading(false);
              resolve(null);
              return;
            }
            if (action !== String(picker.Action.PICKED) && action !== 'picked') return;

            const docs = Array.isArray(data?.docs) ? data.docs : [];
            const doc = docs[0]; // One video initially: use only the first selected item.
            if (!doc) {
              setLoading(false);
              resolve(null);
              return;
            }
            const id = String(
              doc[picker.Document.ID] || doc.id || ''
            ).trim();
            if (!id) {
              setLoading(false);
              reject(new Error('Google Picker did not return a file ID'));
              return;
            }
            setLoading(false);
            pickerInstance?.setVisible(false);
            resolve({
              id,
              name: String(doc[picker.Document.NAME] || doc.name || 'Google Drive video'),
              mimeType: String(doc[picker.Document.MIME_TYPE] || doc.mimeType || ''),
              sizeBytes:
                doc[picker.Document.SIZE_BYTES] !== undefined
                  ? Number(doc[picker.Document.SIZE_BYTES])
                  : null,
              thumbnailUrl:
                doc[picker.Document.THUMBNAIL_URL] || doc.thumbnailUrl || null
                  ? String(doc[picker.Document.THUMBNAIL_URL] || doc.thumbnailUrl)
                  : null,
            });
          };

          const builder = new picker.PickerBuilder()
            .addView(docsView)
            .setOAuthToken(options.oauthToken)
            .setDeveloperKey(options.apiKey)
            .setAppId(options.projectNumber)
            .setTitle('Select one video from Google Drive')
            .setCallback(callback);

          if (picker.Feature?.MULTISELECT_ENABLED) {
            builder.disableFeature(picker.Feature.MULTISELECT_ENABLED);
          }
          if (picker.Feature?.SUPPORT_TEAM_DRIVES) {
            builder.enableFeature(picker.Feature.SUPPORT_TEAM_DRIVES);
          }
          pickerInstance = builder.build();
          pickerInstance.setVisible(true);
        });
      } catch (err: any) {
        const message = String(err?.message || 'Could not open the Google Drive picker');
        if (mountedRef.current) setError(message);
        throw new Error(message);
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    []
  );

  return { openPicker, loading, error, setError };
}
