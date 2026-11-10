#include <avif/avif.h>
#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Each worker owns one module. No handles or heap buffers cross workers. */
typedef struct {
    avifEncoder *codec;
    avifRWData output;
    uint32_t width, height, frames, expected_frames, max_frames, max_pixels, max_ticks, max_bytes;
    uint64_t ticks;
} Encoder;

typedef struct {
    avifDecoder *codec;
    uint8_t *input;
    uint8_t *rgba;
    uint32_t width, height, rgba_size, decoded, transparent;
} Decoder;

static char error_text[512];

static int fail(const char *operation, avifResult result, const avifDiagnostics *diagnostics) {
    snprintf(error_text, sizeof(error_text), "%s: %s%s%s", operation, avifResultToString(result),
             diagnostics && diagnostics->error[0] ? ": " : "",
             diagnostics && diagnostics->error[0] ? diagnostics->error : "");
    return 0;
}

static int reject(const char *message) {
    snprintf(error_text, sizeof(error_text), "%s", message);
    return 0;
}

EMSCRIPTEN_KEEPALIVE const char *dc_error(void) { return error_text; }
EMSCRIPTEN_KEEPALIVE const char *dc_version(void) { return avifVersion(); }
EMSCRIPTEN_KEEPALIVE void *dc_alloc(uint32_t bytes) { return malloc(bytes); }
EMSCRIPTEN_KEEPALIVE void dc_free(void *pointer) { free(pointer); }

EMSCRIPTEN_KEEPALIVE void dc_encoder_destroy(Encoder *state) {
    if (!state) return;
    avifEncoderDestroy(state->codec);
    avifRWDataFree(&state->output);
    free(state);
}

EMSCRIPTEN_KEEPALIVE Encoder *dc_encoder_create(uint32_t width, uint32_t height, uint32_t timescale,
    int repetition_count, int quality, int speed, uint32_t expected_frames, uint32_t max_frames, uint32_t max_pixels,
    uint32_t max_ticks, uint32_t max_bytes) {
    error_text[0] = 0;
    if (!width || !height || width > 1920 || height > 1920 || !timescale || timescale > 1000000 ||
        repetition_count < -1 || quality < 0 || quality > 100 || speed < 0 || speed > 10 ||
        !expected_frames || expected_frames > max_frames || !max_frames || max_frames > 180 || !max_pixels || max_pixels > 25165824 || !max_ticks ||
        !max_bytes || max_bytes > 1572864 || (uint64_t)width * height > max_pixels) {
        reject("Encoder parameters exceed the AVIF safety limits");
        return NULL;
    }
    Encoder *state = calloc(1, sizeof(*state));
    if (!state) { reject("Encoder state allocation failed"); return NULL; }
    state->codec = avifEncoderCreate();
    if (!state->codec) { free(state); reject("avifEncoderCreate failed"); return NULL; }
    state->width = width;
    state->height = height;
    state->max_frames = max_frames;
    state->expected_frames = expected_frames;
    state->max_pixels = max_pixels;
    state->max_ticks = max_ticks;
    state->max_bytes = max_bytes;
    state->codec->timescale = timescale;
    state->codec->repetitionCount = repetition_count;
    state->codec->maxThreads = 1;
    state->codec->quality = quality;
    state->codec->qualityAlpha = AVIF_QUALITY_LOSSLESS;
    state->codec->speed = speed;
    return state;
}

EMSCRIPTEN_KEEPALIVE int dc_encoder_add(Encoder *state, const uint8_t *rgba, uint32_t bytes, uint32_t ticks) {
    if (!state || !rgba || state->output.data || !ticks || bytes != (uint64_t)state->width * state->height * 4 ||
        state->frames >= state->expected_frames || state->frames >= state->max_frames || (uint64_t)(state->frames + 1) * state->width * state->height > state->max_pixels ||
        state->ticks + ticks > state->max_ticks) return reject("RGBA frame bytes, count, pixels or duration exceed encoder limits");
    avifImage *image = avifImageCreate(state->width, state->height, 8, AVIF_PIXEL_FORMAT_YUV444);
    if (!image) return reject("avifImageCreate failed");
    image->colorPrimaries = AVIF_COLOR_PRIMARIES_BT709;
    image->transferCharacteristics = AVIF_TRANSFER_CHARACTERISTICS_SRGB;
    image->matrixCoefficients = AVIF_MATRIX_COEFFICIENTS_IDENTITY;
    image->yuvRange = AVIF_RANGE_FULL;
    avifRGBImage rgb;
    avifRGBImageSetDefaults(&rgb, image);
    rgb.format = AVIF_RGB_FORMAT_RGBA;
    rgb.depth = 8;
    rgb.pixels = (uint8_t *)rgba;
    rgb.rowBytes = state->width * 4;
    rgb.ignoreAlpha = AVIF_FALSE;
    rgb.maxThreads = 1;
    avifResult result = avifImageRGBToYUV(image, &rgb);
    if (result == AVIF_RESULT_OK) result = avifEncoderAddImage(state->codec, image, ticks,
        state->expected_frames == 1 ? AVIF_ADD_IMAGE_FLAG_SINGLE : AVIF_ADD_IMAGE_FLAG_NONE);
    avifImageDestroy(image);
    if (result != AVIF_RESULT_OK) return fail("Encode RGBA frame", result, &state->codec->diag);
    state->frames++;
    state->ticks += ticks;
    return 1;
}

EMSCRIPTEN_KEEPALIVE int dc_encoder_finish(Encoder *state) {
    if (!state || state->frames != state->expected_frames || state->output.data) return reject("Encoder must contain its exact declared frame count");
    avifResult result = avifEncoderFinish(state->codec, &state->output);
    if (result != AVIF_RESULT_OK) return fail("Finish AVIF sequence", result, &state->codec->diag);
    if (state->output.size > state->max_bytes) return reject("Encoded AVIF exceeds its output byte limit");
    return 1;
}

EMSCRIPTEN_KEEPALIVE uint8_t *dc_encoder_data(Encoder *state) { return state->output.data; }
EMSCRIPTEN_KEEPALIVE uint32_t dc_encoder_size(Encoder *state) { return (uint32_t)state->output.size; }

EMSCRIPTEN_KEEPALIVE void dc_decoder_destroy(Decoder *state) {
    if (!state) return;
    avifDecoderDestroy(state->codec);
    free(state->input);
    free(state->rgba);
    free(state);
}

static Decoder *parse_decoder(const uint8_t *input, uint32_t bytes, uint32_t max_dimension,
    uint32_t max_frames, uint32_t max_pixels, uint32_t max_duration_ms) {
    error_text[0] = 0;
    if (!input || !bytes || bytes > 33554432 || !max_dimension || max_dimension > 32768 || !max_frames ||
        max_frames > 180 || !max_pixels || max_pixels > 268435456 || !max_duration_ms || max_duration_ms > 10000) {
        reject("Decoder parameters exceed the AVIF safety limits");
        return NULL;
    }
    Decoder *state = calloc(1, sizeof(*state));
    if (!state) { reject("Decoder state allocation failed"); return NULL; }
    state->codec = avifDecoderCreate();
    state->input = malloc(bytes);
    if (!state->codec || !state->input) { reject("Decoder input allocation failed"); dc_decoder_destroy(state); return NULL; }
    memcpy(state->input, input, bytes);
    state->codec->maxThreads = 1;
    state->codec->imageDimensionLimit = max_dimension;
    state->codec->imageSizeLimit = max_pixels;
    state->codec->imageCountLimit = max_frames;
    state->codec->ignoreExif = AVIF_TRUE;
    state->codec->ignoreXMP = AVIF_TRUE;
    avifResult result = avifDecoderSetIOMemory(state->codec, state->input, bytes);
    if (result == AVIF_RESULT_OK) result = avifDecoderParse(state->codec);
    if (result != AVIF_RESULT_OK) { fail("Parse AVIF", result, &state->codec->diag); dc_decoder_destroy(state); return NULL; }
    avifDecoder *codec = state->codec;
    if (codec->imageCount < 1 || codec->imageCount > (int)max_frames || !codec->image->width || !codec->image->height ||
        codec->image->width > max_dimension || codec->image->height > max_dimension ||
        (uint64_t)codec->image->width * codec->image->height * codec->imageCount > max_pixels ||
        !codec->timescale || codec->timescale > 1000000 || codec->durationInTimescales > UINT32_MAX ||
        codec->durationInTimescales * 1000 > (uint64_t)max_duration_ms * codec->timescale) {
        reject("AVIF dimensions, frame count, total decoded pixels, timescale or duration exceed limits");
        dc_decoder_destroy(state); return NULL;
    }
    uint64_t ticks = 0;
    for (int index = 0; index < codec->imageCount; index++) {
        avifImageTiming timing;
        result = avifDecoderNthImageTiming(codec, index, &timing);
        if (result != AVIF_RESULT_OK || !timing.durationInTimescales || timing.durationInTimescales > UINT32_MAX) {
            reject("AVIF contains invalid or unsupported frame timing"); dc_decoder_destroy(state); return NULL;
        }
        ticks += timing.durationInTimescales;
    }
    if (ticks != codec->durationInTimescales) { reject("AVIF frame durations disagree with its sequence duration"); dc_decoder_destroy(state); return NULL; }
    state->width = codec->image->width;
    state->height = codec->image->height;
    return state;
}

/* A probe parses bounded source metadata. It never claims to validate AV1 frames. */
EMSCRIPTEN_KEEPALIVE Decoder *dc_probe_create(const uint8_t *input, uint32_t bytes) {
    Decoder *state = parse_decoder(input, bytes, 32768, 180, 268435456, 10000);
    if (state && (uint64_t)state->width * state->height > 40000000) {
        reject("AVIF source frame exceeds 40 million pixels"); dc_decoder_destroy(state); return NULL;
    }
    return state;
}

EMSCRIPTEN_KEEPALIVE Decoder *dc_decoder_create(const uint8_t *input, uint32_t bytes, uint32_t max_dimension,
    uint32_t max_frames, uint32_t max_pixels, uint32_t max_duration_ms) {
    if (bytes > 1572864 || max_dimension > 1920 || max_pixels > 25165824) {
        reject("AVIF asset decoder limits exceed their permitted bounds"); return NULL;
    }
    Decoder *state = parse_decoder(input, bytes, max_dimension, max_frames, max_pixels, max_duration_ms);
    if (!state) return NULL;
    state->rgba_size = state->width * state->height * 4;
    state->rgba = malloc(state->rgba_size);
    if (!state->rgba) { reject("Decoder RGBA allocation failed"); dc_decoder_destroy(state); return NULL; }
    return state;
}

EMSCRIPTEN_KEEPALIVE Decoder *dc_source_decoder_create(const uint8_t *input, uint32_t bytes) {
    Decoder *state = dc_probe_create(input, bytes);
    if (!state) return NULL;
    const avifImage *image = state->codec->image;
    if (image->transformFlags != AVIF_TRANSFORM_NONE) {
        reject("Source AVIF requires rotation, mirroring, cropping or pixel-aspect transforms; apply those transforms in an image editor before resizing");
        dc_decoder_destroy(state); return NULL;
    }
    if (image->icc.size || image->gainMap || image->clli.maxCLL || image->clli.maxPALL ||
        (image->colorPrimaries != AVIF_COLOR_PRIMARIES_BT709 && image->colorPrimaries != AVIF_COLOR_PRIMARIES_UNSPECIFIED) ||
        (image->transferCharacteristics != AVIF_TRANSFER_CHARACTERISTICS_SRGB &&
         image->transferCharacteristics != AVIF_TRANSFER_CHARACTERISTICS_UNSPECIFIED)) {
        reject("Source AVIF requires ICC, HDR or non-sRGB color conversion; convert the original image to sRGB in an image editor before resizing");
        dc_decoder_destroy(state); return NULL;
    }
    state->rgba_size = state->width * state->height * 4;
    state->rgba = malloc(state->rgba_size);
    if (!state->rgba) {
        reject("Source AVIF exceeds the codec worker's 256 MiB memory budget; resize the original image first");
        dc_decoder_destroy(state); return NULL;
    }
    return state;
}

EMSCRIPTEN_KEEPALIVE int dc_decoder_next(Decoder *state) {
    if (!state || !state->rgba || state->decoded >= (uint32_t)state->codec->imageCount) return reject("Decoder has no remaining frames");
    avifResult result = avifDecoderNextImage(state->codec);
    if (result != AVIF_RESULT_OK) return fail("Decode AVIF frame", result, &state->codec->diag);
    if (state->codec->image->width != state->width || state->codec->image->height != state->height)
        return reject("Decoded AV1 frame dimensions disagree with the bounded AVIF container");
    avifRGBImage rgb;
    avifRGBImageSetDefaults(&rgb, state->codec->image);
    rgb.format = AVIF_RGB_FORMAT_RGBA;
    rgb.depth = 8;
    rgb.pixels = state->rgba;
    rgb.rowBytes = rgb.width * 4;
    rgb.maxThreads = 1;
    result = avifImageYUVToRGB(state->codec->image, &rgb);
    if (result != AVIF_RESULT_OK) return fail("Convert AVIF frame to RGBA", result, NULL);
    for (uint32_t i = 3; i < state->rgba_size; i += 4) if (state->rgba[i] != 255) { state->transparent = 1; break; }
    state->decoded++;
    return 1;
}

EMSCRIPTEN_KEEPALIVE uint8_t *dc_decoder_rgba(Decoder *state) { return state->rgba; }
EMSCRIPTEN_KEEPALIVE uint32_t dc_decoder_width(Decoder *state) { return state->codec->image->width; }
EMSCRIPTEN_KEEPALIVE uint32_t dc_decoder_height(Decoder *state) { return state->codec->image->height; }
EMSCRIPTEN_KEEPALIVE uint32_t dc_decoder_frames(Decoder *state) { return state->codec->imageCount; }
EMSCRIPTEN_KEEPALIVE uint32_t dc_decoder_timescale(Decoder *state) { return (uint32_t)state->codec->timescale; }
EMSCRIPTEN_KEEPALIVE uint32_t dc_decoder_duration(Decoder *state) { return (uint32_t)state->codec->durationInTimescales; }
EMSCRIPTEN_KEEPALIVE uint32_t dc_decoder_frame_ticks(Decoder *state) { return (uint32_t)state->codec->imageTiming.durationInTimescales; }
EMSCRIPTEN_KEEPALIVE int dc_decoder_repetitions(Decoder *state) { return state->codec->repetitionCount; }
EMSCRIPTEN_KEEPALIVE int dc_decoder_alpha(Decoder *state) { return state->transparent; }
EMSCRIPTEN_KEEPALIVE uint32_t dc_decoder_depth(Decoder *state) { return state->codec->image->depth; }
EMSCRIPTEN_KEEPALIVE uint32_t dc_probe_frame_ticks(Decoder *state, uint32_t index) {
    avifImageTiming timing;
    if (avifDecoderNthImageTiming(state->codec, index, &timing) != AVIF_RESULT_OK) return 0;
    return (uint32_t)timing.durationInTimescales;
}
