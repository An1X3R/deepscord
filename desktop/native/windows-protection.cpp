#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <wincrypt.h>
#include <fcntl.h>
#include <io.h>
#include <array>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr size_t maxBytes = 4 * 1024 * 1024 + 65536;

// Own the sensitive buffers across every error path.
struct ProtectedBuffers {
    std::vector<BYTE> input;
    std::array<BYTE, 8192> chunk{};
    DATA_BLOB output{};
    ~ProtectedBuffers() {
        SecureZeroMemory(input.data(), input.size());
        SecureZeroMemory(chunk.data(), chunk.size());
        if (output.pbData) {
            SecureZeroMemory(output.pbData, output.cbData);
            LocalFree(output.pbData);
        }
    }
};

void run(const std::string& operation) {
    if (operation != "protect" && operation != "unprotect")
        throw std::invalid_argument("Expected protect or unprotect");
    if (_setmode(_fileno(stdin), _O_BINARY) == -1 || _setmode(_fileno(stdout), _O_BINARY) == -1)
        throw std::runtime_error("Cannot initialize binary pipes");
    ProtectedBuffers buffers;
    // Reserve once so reallocation never leaves plaintext in a discarded allocation.
    buffers.input.reserve(maxBytes);
    for (;;) {
        const size_t count = fread(buffers.chunk.data(), 1, buffers.chunk.size(), stdin);
        if (buffers.input.size() + count > maxBytes)
            throw std::length_error("Protection input exceeds its storage budget");
        buffers.input.insert(buffers.input.end(), buffers.chunk.begin(), buffers.chunk.begin() + count);
        if (count < buffers.chunk.size()) {
            if (ferror(stdin)) throw std::runtime_error("Protection input pipe failed");
            break;
        }
    }
    DATA_BLOB input{static_cast<DWORD>(buffers.input.size()), buffers.input.data()};
    const BOOL success = operation == "protect"
        ? CryptProtectData(&input, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &buffers.output)
        : CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &buffers.output);
    if (!success) throw std::runtime_error("DPAPI failed with Win32 code " + std::to_string(GetLastError()));
    if (buffers.output.cbData > maxBytes) throw std::length_error("Protection output exceeds its storage budget");
    if (fwrite(buffers.output.pbData, 1, buffers.output.cbData, stdout) != buffers.output.cbData || fflush(stdout) != 0)
        throw std::runtime_error("Protection output pipe failed");
}
}

int main(int argc, char** argv) {
    try {
        if (argc != 2) throw std::invalid_argument("Expected exactly one operation argument");
        run(argv[1]);
        return 0;
    } catch (const std::exception& error) {
        fprintf(stderr, "Windows protection failed: %s\n", error.what());
        return 1;
    }
}
