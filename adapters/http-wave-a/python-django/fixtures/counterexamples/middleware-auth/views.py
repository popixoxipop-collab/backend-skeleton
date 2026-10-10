from django.http import JsonResponse


def public(request):
    return JsonResponse({"public": True})


def private(request):
    return JsonResponse({"private": True})
