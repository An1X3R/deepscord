#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <dwmapi.h>
#include <array>
#include <charconv>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {
struct WatchState {
    HWND window;
    bool changed;
    bool destroyed;
};
WatchState* activeWatch = nullptr;

void CALLBACK onWindowEvent(HWINEVENTHOOK, DWORD event, HWND window, LONG object, LONG child, DWORD, DWORD) {
    if (!activeWatch || activeWatch->window != window || object != OBJID_WINDOW || child != CHILDID_SELF) return;
    activeWatch->changed = true;
    if (event == EVENT_OBJECT_DESTROY) activeWatch->destroyed = true;
}

uint64_t positiveInteger(std::string_view input, uint64_t maximum) {
    uint64_t value = 0;
    const auto result = std::from_chars(input.data(), input.data() + input.size(), value);
    if (result.ec != std::errc{} || result.ptr != input.data() + input.size() || !value || value > maximum)
        throw std::invalid_argument("Invalid positive numeric window or parent identifier");
    return value;
}

std::string readBounds(HWND window, const std::string& area, DWORD thread, DWORD owner) {
    DWORD currentOwner = 0;
    if (!IsWindow(window) || GetWindowThreadProcessId(window, &currentOwner) != thread || currentOwner != owner)
        throw std::runtime_error("Shared window closed or its handle was replaced");
    DWORD cloaked = 0;
    const HRESULT cloakResult = DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
    if (FAILED(cloakResult)) throw std::runtime_error("DWM cloak query failed: " + std::to_string(cloakResult));
    if (!IsWindowVisible(window) || IsIconic(window) || cloaked) return "null";
    RECT rect{};
    if (area == "frame") {
        const HRESULT result = DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &rect, sizeof(rect));
        if (FAILED(result)) throw std::runtime_error("DWM frame query failed: " + std::to_string(result));
    } else {
        POINT origin{};
        if (!GetClientRect(window, &rect) || !ClientToScreen(window, &origin))
            throw std::runtime_error("Client bounds query failed: " + std::to_string(GetLastError()));
        OffsetRect(&rect, origin.x, origin.y);
    }
    const LONG width = rect.right - rect.left, height = rect.bottom - rect.top;
    if (width <= 0 || height <= 0) throw std::runtime_error("Shared window has empty visible bounds");
    return "{\"x\":" + std::to_string(rect.left) + ",\"y\":" + std::to_string(rect.top) +
        ",\"width\":" + std::to_string(width) + ",\"height\":" + std::to_string(height) + "}";
}

void watch(HWND window, const std::string& area, HANDLE parent) {
    DWORD owner = 0;
    const DWORD thread = GetWindowThreadProcessId(window, &owner);
    if (!thread) throw std::runtime_error("Shared window handle is no longer valid");
    WatchState state{window, true, false};
    activeWatch = &state;
    std::vector<HWINEVENTHOOK> hooks;
    const std::array<DWORD, 8> events{EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_SHOW, EVENT_OBJECT_HIDE,
        EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED, EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, EVENT_OBJECT_DESTROY};
    try {
        for (DWORD event : events) {
            const HWINEVENTHOOK hook = SetWinEventHook(event, event, nullptr, onWindowEvent, owner, thread, WINEVENT_OUTOFCONTEXT);
            if (!hook) throw std::runtime_error("Window event hook failed: " + std::to_string(GetLastError()));
            hooks.push_back(hook);
        }
        std::string previous;
        for (;;) {
            if (state.destroyed) throw std::runtime_error("Shared window was destroyed");
            if (state.changed) {
                state.changed = false;
                const std::string next = readBounds(window, area, thread, owner);
                if (next != previous) {
                    if (printf("%s\n", next.c_str()) < 0 || fflush(stdout) != 0)
                        throw std::runtime_error("Window bounds output pipe failed");
                    previous = next;
                }
            }
            const DWORD result = MsgWaitForMultipleObjectsEx(1, &parent, 500, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
            if (result == WAIT_OBJECT_0) break;
            if (result == WAIT_FAILED) throw std::runtime_error("Window event wait failed: " + std::to_string(GetLastError()));
            if (result == WAIT_TIMEOUT) state.changed = true;
            MSG message{};
            while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    } catch (...) {
        activeWatch = nullptr;
        for (HWINEVENTHOOK hook : hooks) UnhookWinEvent(hook);
        throw;
    }
    activeWatch = nullptr;
    for (HWINEVENTHOOK hook : hooks) UnhookWinEvent(hook);
}
}

int main(int argc, char** argv) {
    HANDLE parent = nullptr;
    try {
        if (argc != 7 || std::string_view(argv[1]) != "-WindowHandle" || std::string_view(argv[3]) != "-CaptureArea" || std::string_view(argv[5]) != "-ParentProcessId")
            throw std::invalid_argument("Expected -WindowHandle number -CaptureArea frame|client -ParentProcessId number");
        const auto handle = positiveInteger(argv[2], static_cast<uint64_t>(std::numeric_limits<intptr_t>::max()));
        const auto parentId = static_cast<DWORD>(positiveInteger(argv[6], MAXDWORD));
        const std::string area(argv[4]);
        if (area != "frame" && area != "client") throw std::invalid_argument("Invalid capture area");
        if (!SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
            throw std::runtime_error("DPI initialization failed: " + std::to_string(GetLastError()));
        parent = OpenProcess(SYNCHRONIZE, FALSE, parentId);
        if (!parent) throw std::runtime_error("Parent process unavailable: " + std::to_string(GetLastError()));
        watch(reinterpret_cast<HWND>(static_cast<uintptr_t>(handle)), area, parent);
        CloseHandle(parent);
        return 0;
    } catch (const std::exception& error) {
        if (parent) CloseHandle(parent);
        fprintf(stderr, "Window bounds failed: %s\n", error.what());
        return 1;
    }
}
