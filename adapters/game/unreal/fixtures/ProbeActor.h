// Authored scope fixture, not compiled or exported by Unreal Engine.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "ProbeActor.generated.h"

UCLASS()
class AProbeActor : public AActor
{
    GENERATED_BODY()

public:
    UPROPERTY(ReplicatedUsing=OnRep_Health)
    float Health;

    UPROPERTY(EditDefaultsOnly)
    TSoftObjectPtr<UStaticMesh> VisualAsset;

    UFUNCTION()
    void OnRep_Health();

    UFUNCTION(Server, Reliable)
    void ServerFire();
};
