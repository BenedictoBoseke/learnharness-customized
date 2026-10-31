#include <jni.h>
#include <android/log.h>
#include <node.h>
#include <unistd.h>
#include <sys/stat.h>
#include <cstdlib>
#include <cstdio>
#include <cctype>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {
std::once_flag log_once;
std::mutex start_mutex;
bool started = false;
std::vector<std::string> private_capabilities;

std::string value(JNIEnv* env, jstring input) {
    if (!input) return {};
    const char* bytes = env->GetStringUTFChars(input, nullptr);
    if (!bytes) return {};
    std::string out(bytes);
    env->ReleaseStringUTFChars(input, bytes);
    return out;
}

bool directory(const std::string& p) {
    struct stat s{};
    return !p.empty() && p.front() == '/' && stat(p.c_str(), &s) == 0 && S_ISDIR(s.st_mode);
}

std::string scrub(std::string line) {
    std::string lower = line;
    for (char& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    for (const char* marker : {"authorization", "access_token", "refresh_token", "id_token", "apikey", "api_key", "accesstoken", "refreshtoken", "bearer ", "sk-"}) {
        if (lower.find(marker) != std::string::npos) return "[sensitive runtime log omitted]";
    }
    for (const auto& secret : private_capabilities) {
        if (!secret.empty() && line.find(secret) != std::string::npos) return "[runtime capability omitted]";
    }
    for (char& c : line) if (static_cast<unsigned char>(c) < 32 && c != '\t') c = ' ';
    return line;
}

void drain_log(int fd, int priority) {
    char buffer[2048];
    std::string line;
    ssize_t n;
    while ((n = read(fd, buffer, sizeof(buffer))) > 0) {
        for (ssize_t i=0; i<n; i++) {
            if (buffer[i] == '\n' || line.size() >= 3500) {
                const auto safe = scrub(line);
                __android_log_write(priority, "LearnHarnessNode", safe.c_str());
                line.clear();
            }
            if (buffer[i] != '\n') line.push_back(buffer[i]);
        }
    }
    if (!line.empty()) __android_log_write(priority, "LearnHarnessNode", scrub(line).c_str());
    close(fd);
}

void redirect_descriptor(int target, int priority) {
    int pipes[2];
    if (pipe(pipes) != 0) return;
    if (dup2(pipes[1], target) < 0) { close(pipes[0]); close(pipes[1]); return; }
    close(pipes[1]);
    std::thread(drain_log, pipes[0], priority).detach();
}

void set(const char* name, const std::string& text) { setenv(name, text.c_str(), 1); }
}

extern "C" JNIEXPORT jint JNICALL
Java_ai_learnharness_mobile_NativeRuntime_start(JNIEnv* env, jclass, jstring root_arg,
    jstring private_arg, jstring cache_arg, jint port, jstring renderer_arg,
    jstring renderer_token_arg, jstring session_token_arg) {
    __android_log_write(ANDROID_LOG_INFO,"LearnHarnessRuntime","JNI start entered");
    std::unique_lock<std::mutex> lock(start_mutex);
    if (started) return 72; // Node initialization cannot be repeated inside this process.
    const auto root=value(env,root_arg), files=value(env,private_arg), cache=value(env,cache_arg);
    const auto renderer=value(env,renderer_arg), renderer_token=value(env,renderer_token_arg), session=value(env,session_token_arg);
    if (env->ExceptionCheck()) return 73;
    if (!directory(root) || !directory(files) || !directory(cache) || port<1 || port>65535 ||
        renderer.rfind("http://127.0.0.1:",0)!=0 || renderer_token.size()<43 || session.size()<43) return 74;
    const auto entry=root+"/mobile/bootstrap.mjs";
    struct stat script{};
    if (stat(entry.c_str(),&script)!=0 || !S_ISREG(script.st_mode)) return 75;
    if (chdir(root.c_str())!=0) return 76;
    started=true;
    lock.unlock();

    private_capabilities={renderer_token,session};
    std::call_once(log_once, [] {
        setvbuf(stdout,nullptr,_IONBF,0); setvbuf(stderr,nullptr,_IONBF,0);
        redirect_descriptor(STDOUT_FILENO,ANDROID_LOG_INFO);
        redirect_descriptor(STDERR_FILENO,ANDROID_LOG_WARN);
    });

    set("LH_ANDROID","1");
    set("LH_DATA_DIR",files+"/original/data");
    set("LH_AUTH_FILE",files+"/original/auth/auth.json");
    set("LH_ANDROID_PRIVATE_ROOT",files);
    set("LH_LOCAL_STATE_DIR",files+"/device-state");
    set("LH_ANDROID_LEGACY_DIR",files);
    set("LH_ANDROID_RENDER_READY","1");
    set("LH_ANDROID_RENDER_URL",renderer);
    set("LH_ANDROID_RENDER_TOKEN",renderer_token);
    set("LH_ANDROID_SESSION_TOKEN",session);
    set("HOSTNAME","127.0.0.1");
    set("PORT",std::to_string(port));
    set("HOME",files);
    set("TMPDIR",cache);
    set("NODE_ENV","production");
    set("NODE_OPTIONS","--max-old-space-size=384");
    set("NODE_COMPILE_CACHE",cache+"/node-compile-cache");
    set("NODE_COMPILE_CACHE_PORTABLE","1");
    unsetenv("LH_DESKTOP_SERVER");
    unsetenv("LH_DESKTOP_API_SECRET");
    unsetenv("LH_DEV_URL");

    const std::vector<std::string> arguments={"node",entry};
    // libuv's process-title machinery requires a single contiguous argv buffer.
    // Separate std::string allocations (including SSO) violate that contract.
    size_t argument_bytes=0;
    for(const auto& argument:arguments)argument_bytes+=argument.size()+1;
    std::vector<char> buffer(argument_bytes,0);
    std::vector<char*> argv(arguments.size()+1,nullptr);
    size_t offset=0;
    for(size_t i=0;i<arguments.size();i++){
        argv[i]=buffer.data()+offset;
        std::memcpy(argv[i],arguments[i].c_str(),arguments[i].size()+1);
        offset+=arguments[i].size()+1;
    }
    __android_log_print(ANDROID_LOG_INFO,"LearnHarnessRuntime","Calling node::Start with %zu contiguous arguments (%zu bytes)",arguments.size(),argument_bytes);
    const int code=node::Start(static_cast<int>(arguments.size()),argv.data());
    __android_log_print(ANDROID_LOG_INFO,"LearnHarnessRuntime","node::Start returned %d",code);
    return code;
}
