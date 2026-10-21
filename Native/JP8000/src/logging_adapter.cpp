#include <cstdio>
#include <string>
// Host logging integration only; the emulated board and CPU/DSP stay unmodified.
namespace Logging {
using LogFunc=void (*)(const std::string&);
static LogFunc sink=nullptr;
void g_logToConsole(const std::string& message){if(sink)sink(message);else std::fprintf(stderr,"%s\n",message.c_str());}
void g_logToFile(const std::string& message){g_logToConsole(message);}
void setLogFunc(LogFunc fn){sink=fn;}
}
