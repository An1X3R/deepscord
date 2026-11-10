#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <tlhelp32.h>
#include <wrl.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

static void check(HRESULT result, const char* operation) {
    if (FAILED(result)) {
        char code[16]{};
        snprintf(code, sizeof(code), "0x%08lx", static_cast<unsigned long>(result));
        throw std::runtime_error(std::string(operation) + " failed (HRESULT " + code + ")");
    }
}

static std::string utf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0) throw std::runtime_error("UTF-8 conversion failed");
    std::string result(static_cast<size_t>(size), '\0');
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr)) throw std::runtime_error("UTF-8 conversion failed");
    return result;
}

static std::string quoted(const std::string& value) {
    std::string result = "\"";
    for (const unsigned char ch : value) {
        if (ch == '"' || ch == '\\') { result += '\\'; result += static_cast<char>(ch); }
        else if (ch < 32) { char escape[7]{}; snprintf(escape, sizeof(escape), "\\u%04x", ch); result += escape; }
        else result += static_cast<char>(ch);
    }
    return result + '"';
}

class Handle final {
public:
    explicit Handle(HANDLE handle) : value(handle) {
        if (!value || value == INVALID_HANDLE_VALUE) throw std::runtime_error("Open Windows handle failed (Win32 " + std::to_string(GetLastError()) + ")");
    }
    ~Handle() { CloseHandle(value); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    HANDLE get() const { return value; }
private:
    HANDLE value;
};

static BOOL CALLBACK collectWindows(HWND window, LPARAM parameter) {
    if (!IsWindowVisible(window) || GetWindow(window, GW_OWNER)) return TRUE;
    wchar_t title[512]{};
    if (!GetWindowTextW(window, title, static_cast<int>(std::size(title)))) return TRUE;
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    auto& result = *reinterpret_cast<std::map<DWORD, std::wstring>*>(parameter);
    result.try_emplace(pid, title);
    return TRUE;
}

static void listProcesses() {
    std::map<DWORD, std::wstring> windows;
    EnumWindows(collectWindows, reinterpret_cast<LPARAM>(&windows));
    std::set<DWORD> audio;
    ComPtr<IMMDeviceEnumerator> enumerator;
    check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)), "Create audio device enumerator");
    ComPtr<IMMDeviceCollection> devices;
    check(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices), "Enumerate playback devices");
    UINT count = 0;
    check(devices->GetCount(&count), "Read playback device count");
    for (UINT index = 0; index < count; ++index) {
        ComPtr<IMMDevice> device;
        check(devices->Item(index, &device), "Read playback device");
        ComPtr<IAudioSessionManager2> manager;
        check(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, &manager), "Read audio session manager");
        ComPtr<IAudioSessionEnumerator> sessions;
        check(manager->GetSessionEnumerator(&sessions), "Enumerate application audio sessions");
        int sessionCount = 0;
        check(sessions->GetCount(&sessionCount), "Read audio session count");
        for (int sessionIndex = 0; sessionIndex < sessionCount; ++sessionIndex) {
            ComPtr<IAudioSessionControl> session;
            check(sessions->GetSession(sessionIndex, &session), "Read audio session");
            ComPtr<IAudioSessionControl2> details;
            check(session.As(&details), "Read audio process interface");
            DWORD pid = 0;
            check(details->GetProcessId(&pid), "Read audio process identity");
            if (pid) audio.insert(pid);
        }
    }
    Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (!Process32FirstW(snapshot.get(), &entry)) throw std::runtime_error("Process snapshot is empty");
    bool separator = false;
    std::cout << '[';
    do {
        if (!audio.count(entry.th32ProcessID) && !windows.count(entry.th32ProcessID)) continue;
        if (separator) std::cout << ',';
        separator = true;
        const auto title = windows.find(entry.th32ProcessID);
        std::cout << "{\"pid\":" << entry.th32ProcessID << ",\"name\":" << quoted(utf8(entry.szExeFile))
                  << ",\"title\":" << quoted(title == windows.end() ? std::string{} : utf8(title->second)) << '}';
    } while (Process32NextW(snapshot.get(), &entry));
    std::cout << "]\n";
}

class Activation final : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
public:
    Activation() : completed(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT activated = E_UNEXPECTED;
        ComPtr<IUnknown> object;
        result = operation->GetActivateResult(&activated, &object);
        if (SUCCEEDED(result)) result = activated;
        if (SUCCEEDED(result)) result = object.As(&client);
        SetEvent(completed.get());
        return S_OK;
    }
    Handle completed;
    ComPtr<IAudioClient> client;
    HRESULT result = E_PENDING;
};

static void writeAll(const BYTE* data, DWORD bytes) {
    const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD sent = 0;
    while (sent < bytes) {
        DWORD written = 0;
        if (!WriteFile(output, data + sent, bytes - sent, &written, nullptr) || written == 0) throw std::runtime_error("Audio pipe closed");
        sent += written;
    }
}

static bool inputClosed() {
    DWORD available = 0;
    if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr)) {
        if (GetLastError() == ERROR_BROKEN_PIPE) return true;
        throw std::runtime_error("Cannot inspect capture control pipe");
    }
    return available > 0;
}

static void captureProcess(DWORD pid, PROCESS_LOOPBACK_MODE mode) {
    Handle process(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
    const auto completion = Microsoft::WRL::Make<Activation>();
    if (!completion) throw std::runtime_error("Cannot allocate audio activation callback");
    AUDIOCLIENT_ACTIVATION_PARAMS activation{};
    activation.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activation.ProcessLoopbackParams.TargetProcessId = pid;
    activation.ProcessLoopbackParams.ProcessLoopbackMode = mode;
    PROPVARIANT parameters{};
    parameters.vt = VT_BLOB;
    parameters.blob.cbSize = sizeof(activation);
    parameters.blob.pBlobData = reinterpret_cast<BYTE*>(&activation);
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    check(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &parameters, completion.Get(), &operation), "Activate process-only audio capture");
    if (WaitForSingleObject(completion->completed.get(), 10000) != WAIT_OBJECT_0) throw std::runtime_error("Process audio activation exceeded 10 seconds");
    check(completion->result, "Activate process audio client");
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = 2;
    format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 16;
    format.nBlockAlign = 4;
    format.nAvgBytesPerSec = 192000;
    check(completion->client->Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        200000, 0, &format, nullptr), "Initialize stereo 48 kHz process capture");
    Handle samples(CreateEventW(nullptr, FALSE, FALSE, nullptr));
    check(completion->client->SetEventHandle(samples.get()), "Set process capture event");
    ComPtr<IAudioCaptureClient> reader;
    check(completion->client->GetService(IID_PPV_ARGS(&reader)), "Get process capture reader");
    check(completion->client->Start(), "Start process audio capture");
    std::cerr << "{\"event\":\"ready\",\"pid\":" << pid << ",\"sampleRate\":48000,\"channels\":2,\"format\":\"s16le\"}\n" << std::flush;
    const HANDLE events[] = { samples.get(), process.get() };
    std::vector<BYTE> silence;
    while (!inputClosed()) {
        const DWORD wait = WaitForMultipleObjects(2, events, FALSE, 200);
        if (wait == WAIT_OBJECT_0 + 1) break;
        if (wait == WAIT_TIMEOUT) continue;
        if (wait != WAIT_OBJECT_0) throw std::runtime_error("Process audio wait failed");
        UINT32 frames = 0;
        check(reader->GetNextPacketSize(&frames), "Read process audio packet size");
        while (frames > 0) {
            BYTE* data = nullptr;
            DWORD flags = 0;
            check(reader->GetBuffer(&data, &frames, &flags, nullptr, nullptr), "Read process audio samples");
            const DWORD bytes = frames * format.nBlockAlign;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) { silence.assign(bytes, 0); data = silence.data(); }
            writeAll(data, bytes);
            check(reader->ReleaseBuffer(frames), "Release process audio packet");
            check(reader->GetNextPacketSize(&frames), "Read next process audio packet size");
        }
    }
    check(completion->client->Stop(), "Stop process audio capture");
    std::cerr << "{\"event\":\"ended\",\"pid\":" << pid << "}\n";
}

int wmain(int argc, wchar_t** argv) {
    try {
        check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "Initialize COM");
        if (argc == 2 && std::wstring(argv[1]) == L"--list") listProcesses();
        else if (argc == 3 && (std::wstring(argv[1]) == L"--capture" || std::wstring(argv[1]) == L"--capture-excluding")) {
            wchar_t* end = nullptr;
            const unsigned long pid = wcstoul(argv[2], &end, 10);
            if (!pid || !end || *end != L'\0') throw std::invalid_argument("Expected a positive process ID");
            _setmode(_fileno(stdout), _O_BINARY);
            captureProcess(static_cast<DWORD>(pid), std::wstring(argv[1]) == L"--capture" ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE);
        } else throw std::invalid_argument("Expected --list, --capture PID or --capture-excluding PID");
        CoUninitialize();
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "{\"event\":\"error\",\"message\":" << quoted(error.what()) << "}\n";
        return 1;
    }
}
