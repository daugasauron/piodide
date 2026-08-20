export function createRaylibDemoSource(movingObjects: number): string {
  const count = Math.max(100, Math.min(10_000, Math.trunc(movingObjects)));
  return `#include "raylib.h"
#include <math.h>

#define PARTICLE_COUNT ${count}

typedef struct {
    Vector2 position;
    Vector2 velocity;
    float phase;
    Color color;
} Particle;

static Particle particles[PARTICLE_COUNT];
static float elapsed;
static unsigned int random_state = 0x9e3779b9u;

static float random_unit(void) {
    random_state ^= random_state << 13;
    random_state ^= random_state >> 17;
    random_state ^= random_state << 5;
    return (float)(random_state & 0xffffu) / 65535.0f;
}

void game_init(void) {
    int width = GetScreenWidth();
    int height = GetScreenHeight();
    for (int i = 0; i < PARTICLE_COUNT; i++) {
        particles[i].position = (Vector2){ random_unit()*width, random_unit()*height };
        particles[i].velocity = (Vector2){ (random_unit()-0.5f)*70.0f, (random_unit()-0.5f)*70.0f };
        particles[i].phase = random_unit()*6.2831853f;
        particles[i].color = (i % 3 == 0) ? (Color){ 187, 154, 247, 220 } :
            ((i % 3 == 1) ? (Color){ 158, 206, 106, 220 } : (Color){ 192, 202, 245, 205 });
    }
}

void game_frame(float delta_seconds) {
    int width = GetScreenWidth();
    int height = GetScreenHeight();
    float dt = delta_seconds > 0.05f ? 0.05f : delta_seconds;
    elapsed += dt;
    Vector2 pointer = GetMousePosition();
    bool attract = IsMouseButtonDown(MOUSE_BUTTON_LEFT);
    if (GetTouchPointCount() > 0) {
        pointer = GetTouchPosition(0);
        attract = true;
    }

    for (int i = 0; i < PARTICLE_COUNT; i++) {
        Particle *particle = &particles[i];
        float wave = elapsed*1.7f + particle->phase;
        particle->velocity.x += cosf(wave)*7.0f*dt;
        particle->velocity.y += sinf(wave*1.13f)*7.0f*dt;
        if (attract) {
            float dx = pointer.x - particle->position.x;
            float dy = pointer.y - particle->position.y;
            float scale = 24.0f*dt/(20.0f + sqrtf(dx*dx + dy*dy));
            particle->velocity.x += dx*scale;
            particle->velocity.y += dy*scale;
        }
        particle->velocity.x *= 0.999f;
        particle->velocity.y *= 0.999f;
        particle->position.x += particle->velocity.x*dt;
        particle->position.y += particle->velocity.y*dt;
        if (particle->position.x < 0) particle->position.x += width;
        if (particle->position.x >= width) particle->position.x -= width;
        if (particle->position.y < 0) particle->position.y += height;
        if (particle->position.y >= height) particle->position.y -= height;
    }

    BeginDrawing();
    ClearBackground((Color){ 11, 12, 16, 255 });
    for (int i = 0; i < PARTICLE_COUNT; i++) {
        Particle *particle = &particles[i];
        DrawPixel((int)particle->position.x, (int)particle->position.y, particle->color);
        if ((i % 28) == 0) {
            Vector2 tail = {
                particle->position.x - particle->velocity.x*0.08f,
                particle->position.y - particle->velocity.y*0.08f
            };
            DrawLineV(particle->position, tail, (Color){ 187, 154, 247, 110 });
        }
    }
    DrawRectangle(12, 12, width < 420 ? width - 24 : 390, 54, (Color){ 21, 22, 30, 225 });
    DrawText("PIODIDE PARTICLE FIELD", 24, 22, 18, (Color){ 187, 154, 247, 255 });
    DrawText("${count} particles  |  hold pointer to attract", 24, 45, 12, (Color){ 158, 206, 106, 255 });
    DrawCircleV(pointer, attract ? 8.0f : 4.0f, (Color){ 192, 202, 245, 210 });
    EndDrawing();
}
`;
}
