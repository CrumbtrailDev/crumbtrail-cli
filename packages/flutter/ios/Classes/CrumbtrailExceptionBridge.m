#import "CrumbtrailExceptionBridge.h"
#include <pthread.h>

static CrumbtrailFlutterExceptionCallback crumbtrailFlutterCallback;
static NSUncaughtExceptionHandler *crumbtrailFlutterPreviousHandler;
static pthread_mutex_t crumbtrailFlutterLock = PTHREAD_MUTEX_INITIALIZER;

static void crumbtrailFlutterExceptionBridge(NSException *exception) {
    pthread_mutex_lock(&crumbtrailFlutterLock);
    CrumbtrailFlutterExceptionCallback callback = crumbtrailFlutterCallback;
    NSUncaughtExceptionHandler *previous = crumbtrailFlutterPreviousHandler;
    pthread_mutex_unlock(&crumbtrailFlutterLock);
    if (callback) callback(exception);
    if (previous && previous != crumbtrailFlutterExceptionBridge) previous(exception);
}

void crumbtrailFlutterInstallExceptionBridge(CrumbtrailFlutterExceptionCallback callback) {
    pthread_mutex_lock(&crumbtrailFlutterLock);
    NSUncaughtExceptionHandler *current = NSGetUncaughtExceptionHandler();
    if (current != crumbtrailFlutterExceptionBridge) {
        crumbtrailFlutterPreviousHandler = current;
    }
    crumbtrailFlutterCallback = callback;
    NSSetUncaughtExceptionHandler(crumbtrailFlutterExceptionBridge);
    pthread_mutex_unlock(&crumbtrailFlutterLock);
}

void crumbtrailFlutterRemoveExceptionBridge(void) {
    pthread_mutex_lock(&crumbtrailFlutterLock);
    crumbtrailFlutterCallback = NULL;
    if (NSGetUncaughtExceptionHandler() == crumbtrailFlutterExceptionBridge) {
        NSSetUncaughtExceptionHandler(crumbtrailFlutterPreviousHandler);
    }
    crumbtrailFlutterPreviousHandler = NULL;
    pthread_mutex_unlock(&crumbtrailFlutterLock);
}

int crumbtrailFlutterExceptionBridgeInstalled(void) {
    pthread_mutex_lock(&crumbtrailFlutterLock);
    int installed = NSGetUncaughtExceptionHandler() == crumbtrailFlutterExceptionBridge;
    pthread_mutex_unlock(&crumbtrailFlutterLock);
    return installed;
}
