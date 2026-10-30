// Video output module. Designed behind an interface so transport-stream saving
// and MP4 remuxing can be swapped. Browser-only processing cannot reliably
// convert MPEG-TS to MP4; provide a documented fallback.

export const OutputMode = {
  TRANSPORT_STREAM: 'ts', // save concatenated .ts (compatible players only)
  MP4_REMUX: 'mp4',     // requires external remuxer
};

export class VideoAssembler {
  constructor({ mode = OutputMode.TRANSPORT_STREAM } = {}) {
    this.mode = mode;
  }

  /**
   * Assemble downloaded segment buffers into a single output.
   * Returns { blob, filename, mime, note }.
   */
  async assemble(segmentsBuffers, filenameBase = 'video') {
    if (!Array.isArray(segmentsBuffers) || segmentsBuffers.length === 0) {
      throw new Error('No segments to assemble');
    }
    if (this.mode === OutputMode.TRANSPORT_STREAM) {
      const blob = new Blob(segmentsBuffers, { type: 'video/mp2t' });
      return {
        blob,
        filename: `${filenameBase}.ts`,
        mime: 'video/mp2t',
        note: 'MPEG-TS transport stream. Playable in compatible players (VLC, etc.). Not an MP4.',
      };
    }
    // MP4 remux not available in-browser without a library (e.g. ffmpeg.wasm).
    throw new Error(
      'MP4 remux requires an external media-processing library (e.g. ffmpeg). ' +
      'Use the transport-stream output or run a remuxing fallback.'
    );
  }

  /**
   * Documented fallback instructions.
   */
  static fallbackInstructions() {
    return [
      'Browser-only processing cannot convert MPEG-TS to MP4.',
      'Option 1: Save as .ts and play in a compatible player.',
      'Option 2: Use ffmpeg: ffmpeg -i input.ts -c copy output.mp4',
      'Option 3: Integrate ffmpeg.wasm in vendor/ for in-browser remuxing.',
    ];
  }
}

export default VideoAssembler;
