#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mmsystem.h>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>

static void check(MMRESULT result, const char* operation) {
    if (result != MMSYSERR_NOERROR) throw std::runtime_error(std::string(operation) + " failed: " + std::to_string(result));
}

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::invalid_argument("Expected frequency argument");
        const double frequency = std::stod(argv[1]);
        if (frequency < 100 || frequency > 4000) throw std::invalid_argument("Frequency must be 100..4000 Hz");
        WAVEFORMATEX format{};
        format.wFormatTag = WAVE_FORMAT_PCM;
        format.nChannels = 2;
        format.nSamplesPerSec = 48000;
        format.wBitsPerSample = 16;
        format.nBlockAlign = 4;
        format.nAvgBytesPerSec = 192000;
        const HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!event) throw std::runtime_error("Cannot create tone completion event");
        HWAVEOUT output = nullptr;
        check(waveOutOpen(&output, WAVE_MAPPER, &format, reinterpret_cast<DWORD_PTR>(event), 0, CALLBACK_EVENT), "Open tone playback");
        std::array<std::array<int16_t, 9600>, 4> samples{};
        std::array<WAVEHDR, 4> headers{};
        uint64_t frame = 0;
        for (size_t slot = 0; slot < headers.size(); ++slot) {
            for (size_t index = 0; index < samples[slot].size(); index += 2) {
                const auto value = static_cast<int16_t>(327.0 * std::sin(6.283185307179586 * frequency * static_cast<double>(frame++) / 48000.0));
                samples[slot][index] = value;
                samples[slot][index + 1] = value;
            }
            headers[slot].lpData = reinterpret_cast<LPSTR>(samples[slot].data());
            headers[slot].dwBufferLength = static_cast<DWORD>(samples[slot].size() * sizeof(int16_t));
            check(waveOutPrepareHeader(output, &headers[slot], sizeof(WAVEHDR)), "Prepare tone samples");
            check(waveOutWrite(output, &headers[slot], sizeof(WAVEHDR)), "Submit tone samples");
        }
        std::cout << "{\"event\":\"ready\",\"frequency\":" << frequency << "}\n" << std::flush;
        const ULONGLONG deadline = GetTickCount64() + 60000;
        while (GetTickCount64() < deadline) {
            if (WaitForSingleObject(event, 1000) == WAIT_FAILED) throw std::runtime_error("Tone completion wait failed");
            for (size_t slot = 0; slot < headers.size(); ++slot) {
                if (!(headers[slot].dwFlags & WHDR_DONE)) continue;
                for (size_t index = 0; index < samples[slot].size(); index += 2) {
                    const auto value = static_cast<int16_t>(327.0 * std::sin(6.283185307179586 * frequency * static_cast<double>(frame++) / 48000.0));
                    samples[slot][index] = value;
                    samples[slot][index + 1] = value;
                }
                check(waveOutWrite(output, &headers[slot], sizeof(WAVEHDR)), "Continue tone playback");
            }
        }
        check(waveOutReset(output), "Reset tone playback");
        for (auto& header : headers) check(waveOutUnprepareHeader(output, &header, sizeof(WAVEHDR)), "Release tone samples");
        check(waveOutClose(output), "Close tone playback");
        CloseHandle(event);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
