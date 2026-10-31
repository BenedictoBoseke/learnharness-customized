cmake_minimum_required(VERSION 3.22.1)
project(learnharness_runtime LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION
    "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so")

add_library(learnharness-runtime SHARED runtime.cpp)
target_include_directories(learnharness-runtime SYSTEM PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/include/node")
find_library(android_log log REQUIRED)
target_link_libraries(learnharness-runtime PRIVATE node ${android_log})
target_compile_options(learnharness-runtime PRIVATE -Wall -Wextra -Werror=return-type)
target_link_options(learnharness-runtime PRIVATE "-Wl,-z,max-page-size=16384")
