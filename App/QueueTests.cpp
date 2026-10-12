#include "CommandQueue.hpp"
#include <thread>
#include <cassert>
#include <vector>
int main(){
    CommandQueue q;constexpr int n=15000,producers=3;
    std::vector<std::thread> threads;
    for(int p=0;p<producers;p++)threads.emplace_back([&,p]{for(int i=0;i<n;i++)while(!q.push({0,(uint32_t)p,(uint32_t)i,0}))std::this_thread::yield();});
    int received=0,expected[producers]={0};Command c;
    while(received<n*producers){if(q.pop(c)){assert(c.a<producers);assert(c.b==expected[c.a]++);received++;}else std::this_thread::yield();}
    for(auto &t:threads)t.join();
    for(int p=0;p<producers;p++)assert(expected[p]==n);
}
