// adapted from https://gist.github.com/ngbrown/d62eb518753378eb0a9bf02bb4723235
// modified from https://gist.github.com/WorldMaker/a3cbe0059acd827edee568198376b95a
// https://github.com/woltapp/react-blurhash/issues/3

import { useEffect, useState, useMemo } from 'react';

import decode from './decode';
import { isBlurhashString } from '../resolveSources';

export function useBlurhash(
  blurhash: { uri?: string; width?: number; height?: number } | undefined | null,
  punch: number = 1
) {
  punch = punch || 1;

  const [uri, setUri] = useState<string | null>(null);

  useEffect(() => {
    let isCanceled = false;

    if (!blurhash || !blurhash.uri || !isBlurhashString(blurhash.uri)) return;

    const pixels = decode(blurhash.uri, blurhash?.width ?? 32, blurhash?.height ?? 32, punch);

    const canvas = document.createElement('canvas');
    canvas.width = blurhash?.width ?? 32;
    canvas.height = blurhash?.height ?? 32;
    const context = canvas.getContext('2d');
    const imageData = context!.createImageData(blurhash?.width ?? 32, blurhash?.height ?? 32);
    imageData.data.set(pixels);
    context!.putImageData(imageData, 0, 0);
    canvas.toBlob((blob) => {
      if (!isCanceled) {
        setUri((oldUrl) => {
          if (oldUrl) {
            URL.revokeObjectURL(oldUrl);
          }
          return blob ? URL.createObjectURL(blob) : oldUrl;
        });
      }
    });

    return function cleanupBlurhash() {
      isCanceled = true;
      setUri((oldUrl) => {
        if (oldUrl) {
          URL.revokeObjectURL(oldUrl);
        }
        return null;
      });
    };
  }, [blurhash?.uri, blurhash?.height, blurhash?.width, punch]);
  return useMemo(() => (uri ? { uri } : null), [uri]);
}
