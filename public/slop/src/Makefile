CC := cc
LD := ld
CFLAGS := -O2 -Wall -Wextra

.PHONY: all clean
all: slop.unpatched.wasm make.unpatched.wasm coreutils.unpatched.wasm sed.wasm ar.wasm git.unpatched.wasm

spawn_stub.o: spawn_stub.c
	$(CC) -std=c17 $(CFLAGS) -c $< -o $@

slop.o: slop.c
	$(CC) -std=c17 $(CFLAGS) -c $< -o $@
slop.unpatched.wasm: spawn_stub.o slop.o
	$(LD) -s --export=piodide_spawn $^ -o $@

make.o: make.c
	$(CC) -std=c17 $(CFLAGS) -c $< -o $@
make.unpatched.wasm: spawn_stub.o make.o
	$(LD) -s --export=piodide_spawn $^ -o $@

coreutils.o: coreutils.c
	$(CC) -std=c17 $(CFLAGS) -c $< -o $@
coreutils.unpatched.wasm: spawn_stub.o coreutils.o
	$(LD) -s --export=piodide_spawn $^ -o $@

sed.o: sed.c
	$(CC) -std=c17 $(CFLAGS) -c $< -o $@
sed.wasm: sed.o
	$(LD) -s $< -o $@

ar.o: ar.c
	$(CC) -std=c17 $(CFLAGS) -c $< -o $@
ar.wasm: ar.o
	$(LD) -s $< -o $@

git.o: git.c
	$(CC) -std=c17 $(CFLAGS) -c $< -o $@
git.unpatched.wasm: spawn_stub.o git.o
	$(LD) -s --export=piodide_spawn $^ -o $@

# The browser linker validates custom imports by first linking spawn_stub.o.
# Run patch_import.py under Python to replace that placeholder with the real
# piodide.spawn import before installing slop, make, or coreutils.
clean:
	rm -f *.o *.wasm
