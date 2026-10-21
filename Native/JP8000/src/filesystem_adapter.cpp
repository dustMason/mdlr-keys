// SPDX-License-Identifier: GPL-3.0-or-later
#include <fstream>
#include <string>
#include <vector>
namespace baseLib::filesystem {
bool readFile(std::vector<unsigned char>&out,const std::string&path){std::ifstream f(path,std::ios::binary);if(!f)return false;out.assign(std::istreambuf_iterator<char>(f),{});return true;}
std::string getFilenameWithoutPath(const std::string&path){const auto p=path.find_last_of("/\\");return p==std::string::npos?path:path.substr(p+1);}
}
