#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <atomic>
#include <charconv>
#include <cstdio>
#include <string_view>
#include <thread>

int main(int argc, char** argv) {
    if (argc != 2) { std::fprintf(stderr, "Expected one virtual key argument\n"); return 2; }
    const std::string_view argument(argv[1]);
    unsigned int key = 0;
    const auto result = std::from_chars(argument.data(), argument.data() + argument.size(), key);
    if (result.ec != std::errc{} || result.ptr != argument.data() + argument.size() || key < 1 || key > 254) {
        std::fprintf(stderr, "Virtual key must be an integer between 1 and 254\n"); return 2;
    }
    std::atomic_bool running(true);
    std::thread input([&running]() {
        char byte = 0;
        DWORD count = 0;
        while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), &byte, 1, &count, nullptr) && count > 0) {}
        running.store(false);
    });
    bool previous = false;
    bool armed = false;
    ULONGLONG heartbeat = GetTickCount64();
    std::puts("UP"); std::fflush(stdout);
    while (running.load()) {
        const bool down = (GetAsyncKeyState(static_cast<int>(key)) & 0x8000) != 0;
        if (!down) armed = true;
        const bool active = armed && down;
        if (active != previous) {
            previous = active;
            std::puts(active ? "DOWN" : "UP");
            if (std::fflush(stdout) != 0) break;
        }
        if (GetTickCount64() - heartbeat >= 1000) {
            heartbeat = GetTickCount64(); std::puts("PING");
            if (std::fflush(stdout) != 0) break;
        }
        Sleep(8);
    }
    CancelSynchronousIo(input.native_handle());
    input.join();
    return 0;
}
